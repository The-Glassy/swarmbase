/** Real kernel checks. See scripts/setup-test-users.sh; never uses paid APIs. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.js';
import { ensureEmptyMcpConfig, runClaudeAgent, type ClaudeAgentSpec } from '../src/engines/claude.js';
import { renderConfig, runCodexAgent, type CodexAgentSpec } from '../src/engines/codex.js';
import { UsageMeter } from '../src/meter.js';
import { RunManager } from '../src/runs.js';
import { RunStore } from '../src/store.js';
import { initializeCallerUsers, spawnAgent, userOperation } from '../src/users.js';

const enabled = process.env.SWARMBASE_TEST_USERS === '1';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('real caller users: both engines/profiles, EACCES boundaries, ownership, cleanup, descendants and daemon loss',
  { skip: !enabled && 'set SWARMBASE_TEST_USERS=1 after running scripts/setup-test-users.sh', timeout: 90_000 }, async (t) => {
    assert.equal(process.platform, 'linux');
    assert.equal(execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), 'swarmbase-test-daemon', 'run as the test daemon, never root');
    const dataDir = mkdtempSync('/home/swarmbase-test-daemon/state/integration-');
    for (const name of ['a', 'b']) writeFileSync(join(dataDir, `${name}.key`), `test-key-${name}`, { mode: 0o600 });
    const configPath = join(dataDir, 'config.json');
    const rawConfig = {
      dataDir, port: 0,
      engines: { claude: { bin: '/usr/local/libexec/swarmbase-test-agent' },
        codex: { baseUrl: 'http://127.0.0.1:1', bin: '/usr/local/libexec/swarmbase-test-agent', sandbox: 'none' } } as never,
      callers: ['a', 'b'].map((name) => ({ name, tokenSha256: name.repeat(64), apiKeyFile: join(dataDir, `${name}.key`),
        runAs: `swarmbase-test-${name}`, engines: ['claude', 'codex'], maxProfile: 'write',
        cwdGid: Number(execFileSync('getent', ['group', `swarmbase-test-${name}-workspace`], {encoding:'utf8'}).split(':')[2]),
        cwdRoots: [`/home/swarmbase-test-${name}/projects`, `/srv/swarmbase-test-${name}/workspace`] })) as never,
    };
    writeFileSync(configPath, JSON.stringify(rawConfig), { mode: 0o600 });
    const cfg = parseConfig({ ...rawConfig, configPath });
    const users = initializeCallerUsers(cfg);
    const store = new RunStore(dataDir, users);
    const user = users.get('a')!;
    const uid = Number(execFileSync('id', ['-u', user.user], { encoding: 'utf8' }).trim());
    const meta = store.create({ caller: 'a', label: null, script: '', args: null, defaults: {}, budgetUsd: 1, budgetTokens: 1, resumedFrom: null });
    const cwd = store.workDir(meta);
    const runDir = dirname(cwd);
    const probe = JSON.stringify({ action: 'probe', otherKey: join(dataDir, 'b.key'), otherRoot: '/home/swarmbase-test-b/projects' });
    let n = 0;
    const base = (): ClaudeAgentSpec => ({ runId: meta.id, n: ++n, label: 'probe', prompt: probe, schema: null, model: 'fake',
      effort: null, profile: 'write', cwd, timeoutMs: 10_000, maxBudgetUsd: null, streamPath: store.agentStreamPath(meta, n),
      credential: { kind: 'apiKey', value: 'test-key-a' }, secretFiles: [], agentMcp: null, apiBaseUrl: null, claudeBin: '/usr/local/libexec/swarmbase-test-agent',
      emptyMcpConfigPath: '/never-read-daemon-mcp', dataDir, callerUser: user, homeDir: store.agentHomeDir(meta, n), workDir: cwd });
    const meter = new UsageMeter();
    await meter.start();
    const saved = process.env.DAEMON_SECRET;
    process.env.DAEMON_SECRET = 'B-TOKEN-MUST-NOT-LEAK';
    try {
      await t.test('the default work directory starts empty and accepts git clone into dot', async () => {
        const fixture = spawnAgent('/bin/sh', ['-ec',
          'git init --bare /tmp/source.git && git clone /tmp/source.git . && test -d .git && touch /var/tmp/clone-ok'],
        cwd, { PATH: '/usr/bin:/bin', HOME: user.root }, '', user, { workDir: cwd });
        let stderr = '';
        fixture.stderr.on('data', (b) => { stderr += b; });
        assert.equal((await once(fixture, 'close'))[0], 0, stderr);
        assert.ok(existsSync(join(cwd, '.git')));
        const paths = [join(runDir, 'tmp', 'source.git'), join(runDir, 'var-tmp', 'clone-ok')];
        assert.ok(userOperation(user, { op: 'check', paths }).paths.every((p: { read: boolean }) => p.read));
        store.deleteWork(meta);
      });

      await t.test('startup checks use real caller accounts and reject accessible cross-caller paths', () => {
        const publicKey = join('/tmp', `swarmbase-public-${meta.id}.key`);
        writeFileSync(publicKey, 'public-test-key', { mode: 0o644 });
        try {
          const bad = { ...cfg, callers: cfg.callers.map((c) => c.name === 'b' ? { ...c, apiKeyFile: publicKey } : c) };
          assert.throws(() => initializeCallerUsers(bad), /can access.*swarmbase-public.*chmod 0600|credential.*daemon-owned 0600/);
          assert.throws(() => initializeCallerUsers({ ...cfg, callers: cfg.callers.map((c) => ({ ...c, runAs: 'swarmbase-test-no-such-user' })) }), /useradd|unknown user/);
          assert.throws(() => initializeCallerUsers({ ...cfg, userHelper: '/usr/local/libexec/no-such-swarmbase-helper' }), /install.*0755/);
          assert.throws(() => initializeCallerUsers({ ...cfg, userHelper: '/usr/bin/true' }), /NOPASSWD/);
          assert.throws(() => initializeCallerUsers({ ...cfg, callers: cfg.callers.map((c) => ({ ...c, runAs: 'swarmbase-test-a' })) }), /distinct non-root uid/);
        } finally { rmSync(publicKey, { force: true }); }
      });

      for (const profile of ['write', 'read', 'think'] as const) await t.test(`claude ${profile} runs as A; B's key and root return EACCES`, async () => {
        const s = { ...base(), profile };
        const outcome = await runClaudeAgent(s, new AbortController().signal, () => {});
        assert.equal(outcome.ok, true, outcome.error ?? '');
        const r = JSON.parse(String(outcome.result));
        assert.equal(r.uid, uid);
        assert.equal(r.keyError, 13);
        assert.equal(r.rootError, 13);
        assert.equal(r.ownWrite, true);
        assert.equal(r.apiKey, 'test-key-a');
        assert.equal(r.daemonSecret, undefined);
        assert.equal(statSync(cwd).uid, uid);
        assert.equal(statSync(cwd).mode & 0o007, 0);
        assert.equal(existsSync(s.homeDir!), false, 'throwaway home removed as caller');
      });

      await t.test('shared tenant gid accepts a foreign-owned setgid workspace; artifacts inherit group rw', async () => {
        const s = {...base(), cwd: '/srv/swarmbase-test-a/workspace'};
        const outcome = await runClaudeAgent(s, new AbortController().signal, () => {});
        assert.equal(outcome.ok, true, outcome.error ?? '');
        const st = statSync(join(s.cwd, 'own.txt'));
        assert.equal(st.gid, cfg.callers[0].cwdGid);
        assert.equal(st.mode & 0o066, 0o060);
        assert.equal(st.mode & 0o007, 0);
      });

      await t.test('absolute temp paths and sockets are separate per run, with caller-owned backing paths', async () => {
        const start = (caller: string) => store.create({ caller, label: null, script: '', args: null,
          defaults: {}, budgetUsd: 1, budgetTokens: 1, resumedFrom: null });
        const same = start('a');
        const other = start('b');
        const guestFile = `guest-${meta.id}`;
        const marker = `run-${meta.id}`;
        const absMarker = join(runDir, 'tmp', marker);
        const request = { ...JSON.parse(probe), scratch: marker, guestFile, otherScratch: absMarker };
        writeFileSync(join('/tmp', guestFile), 'guest-only', { mode: 0o644 });
        try {
          const s = { ...base(), cwd: '/srv/swarmbase-test-a/workspace', prompt: JSON.stringify({ ...request, nested: true }) };
          const claude = await runClaudeAgent(s, new AbortController().signal, () => {});
          assert.equal(claude.ok, true, claude.error ?? '');
          const first = JSON.parse(String(claude.result));
          assert.equal(first.tmpEnv, '/tmp');
          assert.equal(first.tmpDevice, statSync(cwd).dev);
          assert.equal(first.varTmpDevice, statSync(cwd).dev);
          assert.equal(first.guestFile, false);
          assert.equal(first.existingScratch, false);
          const check = (paths: string[]) => userOperation(user, { op: 'check', paths }).paths;
          assert.ok(check([absMarker, absMarker + '.nested', join(runDir, 'var-tmp', marker)]).every((p: any) => p.read));
          assert.equal(existsSync(join('/tmp', marker)), false);
          assert.equal(existsSync(join('/var/tmp', marker)), false);
          for (const sandbox of ['none', 'bwrap'] as const) {
            const cs = base();
            const codex = await runCodexAgent({ ...cs, homeDir: cs.homeDir!, apiKey: 'test-key-a', maxTokens: 1000,
              baseUrl: 'http://127.0.0.1:1', codexBin: '/usr/local/libexec/swarmbase-test-agent', sandbox,
              extraRoBinds: [], denyExtra: [], prompt: JSON.stringify(request) }, meter, new AbortController().signal, () => {});
            assert.equal(codex.ok, true, codex.error ?? '');
            const r = JSON.parse(String(codex.result));
            assert.equal(r.tmpInode, first.tmpInode);
            assert.equal(r.varTmpInode, first.varTmpInode);
            assert.equal(r.existingScratch, true);
            assert.equal(r.tmpEnv, '/tmp');
          }
          for (const run of [same, other]) {
            const work = store.workDir(run);
            const outcome = await runClaudeAgent({ ...base(), cwd: work, workDir: work, callerUser: store.userContext(run),
              homeDir: store.agentHomeDir(run, n), prompt: JSON.stringify(request) }, new AbortController().signal, () => {});
            assert.equal(outcome.ok, true, outcome.error ?? '');
            const r = JSON.parse(String(outcome.result));
            assert.equal(r.existingScratch, false);
            assert.notEqual(r.tmpInode, first.tmpInode);
            assert.equal(r.otherScratch, run === other ? 13 : undefined);
          }
        } finally {
          for (const run of [same, other]) {
            const owner = store.userContext(run)!;
            userOperation(owner, { op: 'remove', path: join(owner.root, '.swarmbase', run.id) });
          }
          rmSync(join('/tmp', guestFile), { force: true });
        }
      });
      await t.test('OAuth/MCP and ChatGPT auth are private to caller; refresh survives home removal', async () => {
        const authFile = join(dataDir, 'chat-auth.json');
        const mcpFile = join(dataDir, 'browser.json');
        writeFileSync(authFile, '{}', {mode: 0o600});
        writeFileSync(mcpFile, '{"mcpServers":{}}', {mode: 0o600});
        const s = {...base(), credential: {kind: 'authToken' as const, value: 'test-oauth'},
          agentMcp: {configPath: mcpFile, allowedTools: ['mcp__bosun__read']}};
        const claude = await runClaudeAgent(s, new AbortController().signal, () => {});
        assert.equal(claude.ok, true, claude.error ?? '');
        const c = JSON.parse(String(claude.result));
        assert.equal(c.oauth, 'test-oauth');
        assert.equal(c.apiKey, undefined);
        assert.equal(c.mcpMode, 0o600);
        assert.equal(c.homeMode, 0o700);
        for (const sandbox of ['none', 'bwrap'] as const) {
          const cs = base();
          const out = await runCodexAgent({...cs, homeDir: cs.homeDir!, apiKey:'', codexAuthFile:authFile,
            maxTokens:1000, baseUrl:null, codexBin:'/usr/local/libexec/swarmbase-test-agent', sandbox, extraRoBinds:[], denyExtra:[]},
          null, new AbortController().signal, () => {});
          assert.equal(out.ok, true, out.error ?? '');
          assert.equal(out.billing, 'subscription');
          assert.equal(out.costUsd, 0);
          assert.equal(JSON.parse(String(out.result)).authMode, 0o600);
          assert.equal(JSON.parse(readFileSync(authFile, 'utf8')).refreshed, true);
          assert.equal(existsSync(cs.homeDir!), false);
        }
      });

      const realCodex = process.env.CODEX_BIN;
      await t.test('the real Codex inner write sandbox uses both private mounts with a tenant workspace cwd',
        { skip: !realCodex && 'set CODEX_BIN to the installed Codex CLI' }, async () => {
          const cs = base();
          const s: CodexAgentSpec = { ...cs, cwd: '/srv/swarmbase-test-a/workspace', codexBin: realCodex!, homeDir: cs.homeDir!,
            maxTokens: 1000, apiKey: '', baseUrl: null, sandbox: 'none', extraRoBinds: [], denyExtra: [] };
          const args = ['sandbox', '-P', 'swarm-write', '--', '/bin/sh', '-ec', 'touch /tmp/real-codex /var/tmp/real-codex'];
          const child = spawnAgent(realCodex!, args, s.cwd, {
            PATH: '/usr/local/bin:/usr/bin:/bin', HOME: s.homeDir, CODEX_HOME: s.homeDir, TMPDIR: '/tmp',
          }, '', user, { workDir: cwd, files: { home: s.homeDir, files: { 'config.toml': renderConfig(s) } } });
          let stderr = '';
          child.stderr.on('data', (b) => { stderr += b; });
          try {
            const code = await new Promise<number | null>((resolve, reject) => {
              child.once('error', reject);
              child.once('close', resolve);
            });
            assert.equal(code, 0, stderr);
            const paths = [join(runDir, 'tmp', 'real-codex'), join(runDir, 'var-tmp', 'real-codex')];
            assert.ok(userOperation(user, { op: 'check', paths }).paths.every((p: any) => p.read));
          } finally {
            userOperation(user, { op: 'remove', path: s.homeDir });
          }
        });

      for (const sandbox of ['none', 'bwrap'] as const) for (const profile of ['write', 'read', 'think'] as const) await t.test(`codex ${profile}, ${sandbox}: CLI and outer wrapper run as A`, async () => {
        const s = base();
        const outcome = await runCodexAgent({ ...s, apiKey: 'test-key-a', homeDir: s.homeDir!, maxTokens: 1000,
          prompt: JSON.stringify({ action: 'probe', write: profile === 'write', otherKey: join(dataDir, 'b.key'), otherRoot: '/home/swarmbase-test-b/projects' }),
          profile, baseUrl: 'http://127.0.0.1:1', codexBin: '/usr/local/libexec/swarmbase-test-agent', sandbox, extraRoBinds: [], denyExtra: [] },
        meter, new AbortController().signal, () => {});
        assert.equal(outcome.ok, true, outcome.error ?? '');
        const r = JSON.parse(String(outcome.result));
        assert.equal(r.uid, uid);
        // bwrap doesn't mount B's files; plain Linux uid boundary returns EACCES.
        assert.equal(r.keyError, sandbox === 'none' ? 13 : 2);
        assert.equal(r.rootError, sandbox === 'none' ? 13 : 2);
        assert.equal(r.apiKey, undefined, 'gateway key stays in the daemon meter');
        assert.equal(r.daemonSecret, undefined);
        assert.deepEqual(r.directoryFds, [], 'no host-directory fd may escape the wrapper');
        assert.equal(existsSync(s.homeDir!), false);
        assert.equal(meter.active, 0);
      });

      await t.test('cancel kills the caller process and a double-forked setsid descendant', async () => {
        const s = { ...base(), prompt: '{"action":"hold"}', timeoutMs: null };
        const ac = new AbortController();
        const pending = runClaudeAgent(s, ac.signal, () => {});
        try {
          for (let i = 0; i < 200 && !existsSync(join(cwd, 'escaped.pid')); i++) await delay(20);
          assert.ok(existsSync(join(cwd, 'escaped.pid')));
          const pids = ['agent.pid', 'escaped.pid'].map((p) => Number(readFileSync(join(cwd, p), 'utf8')));
          ac.abort();
          const outcome = await pending;
          assert.equal(outcome.reason, 'cancelled');
          for (const pid of pids) assert.equal(existsSync(`/proc/${pid}`), false, `orphan ${pid}`);
        } finally { ac.abort(); await pending; }
      });

      await t.test('control-channel EOF on daemon loss reaps all descendants', async () => {
        for (const p of ['agent.pid', 'escaped.pid']) {
          // Deletion also happens under A's uid, never using daemon authority.
          userOperation(user, { op: 'remove', path: join(cwd, p) });
        }
        const child = spawnAgent('/usr/local/libexec/swarmbase-test-agent', [], cwd,
          { PATH: '/usr/bin:/bin', HOME: user.root }, '{"action":"hold"}', user, { workDir: cwd });
        let stderr = '';
        child.stderr.on('data', (b) => { stderr += b; });
        const closed = new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', () => resolve());
        });
        try {
          for (let i = 0; i < 200 && !existsSync(join(cwd, 'escaped.pid')); i++) await delay(20);
          assert.ok(existsSync(join(cwd, 'escaped.pid')), stderr);
          const pids = ['agent.pid', 'escaped.pid'].map((p) => Number(readFileSync(join(cwd, p), 'utf8')));
          child.stdin.end();
          await closed;
          for (const pid of pids) assert.equal(existsSync(`/proc/${pid}`), false, `orphan ${pid}`);
        } finally { child.stdin.end(); await closed; }
      });

      await t.test('cancel through RunManager reaps the run and all caller-user processes', async () => {
        let ended!: () => void;
        const done = new Promise<void>((resolve) => { ended = resolve; });
        const manager = new RunManager(cfg, store, ensureEmptyMcpConfig(dataDir), { runEnded: () => ended() }, meter);
        const run = manager.start({ caller: cfg.callers[0], script: `await agent('{"action":"hold"}', {profile:'write'}); return 1;`,
          args: null, label: 'cancel-integration', defaults: {}, budgetUsd: 1, budgetTokens: 1_000_000, resumeFrom: null, keepWork: true });
        try {
          const work = store.workDir(run);
          for (let i = 0; i < 300 && !existsSync(join(work, 'escaped.pid')) && run.status === 'running'; i++) await delay(20);
          assert.ok(existsSync(join(work, 'escaped.pid')), run.error ?? 'agent did not start');
          assert.equal(manager.cancel(run.id, 'integration'), true);
          await done;
          assert.equal(run.status, 'cancelled');
          assertNoAProcesses();
        } finally {
          manager.shutdown();
          userOperation(user, { op: 'remove', path: join(user.root, '.swarmbase', run.id) });
        }
      });

      await t.test('run completion deletes both 0555 temp trees unless keepWork is set', async () => {
        for (const keepWork of [false, true]) {
          let ended!: () => void;
          const done = new Promise<void>((resolve) => { ended = resolve; });
          const manager = new RunManager(cfg, store, ensureEmptyMcpConfig(dataDir), { runEnded: () => ended() }, meter);
          const request = { ...JSON.parse(probe), scratch: 'work-cleanup', guestFile: 'absent', otherScratch: '/absent', readOnlyScratch: true };
          const run = manager.start({ caller: cfg.callers[0], script: `return await agent(${JSON.stringify(JSON.stringify(request))}, {profile:'write'});`,
            args: null, label: 'tmp-cleanup', defaults: {}, budgetUsd: 1, budgetTokens: 1_000_000, resumeFrom: null, keepWork });
          try {
            await done;
            assert.equal(run.status, 'completed', run.error ?? '');
            const runDir = dirname(store.workDir(run));
            const paths = [join(runDir, 'tmp', 'cache', 'file'), join(runDir, 'var-tmp', 'cache', 'file')];
            const checks = userOperation(user, { op: 'check', paths }).paths;
            assert.deepEqual(checks.map((p: any) => p.read), [keepWork, keepWork]);
            if (!keepWork) assert.deepEqual(userOperation(user, { op: 'check', paths: [join(runDir, 'tmp'), join(runDir, 'var-tmp')] }).paths
              .map((p: any) => p.directory), [false, false]);
          } finally {
            manager.shutdown();
            userOperation(user, { op: 'remove', path: join(user.root, '.swarmbase', run.id) });
          }
        }
      });

      await t.test('restart sweeps 0555 caller scratch and homes after an interrupted run', async () => {
        const create = () => store.create({ caller: 'a', label: null, script: '', args: null, defaults: {},
          budgetUsd: 1, budgetTokens: 1, resumedFrom: null });
        const orphan = create();
        const broken = create();
        const brokenDir = join(user.root, '.swarmbase', broken.id);
        broken.callerRoot = '/no-longer-configured';
        store.saveMeta(broken);
        orphan.agentsTotal = 1;
        store.saveMeta(orphan);
        const work = store.workDir(orphan);
        const home = store.agentHomeDir(orphan, 1);
        try {
          const fixture = spawnAgent('/bin/sh', ['-ec', 'mkdir /tmp/cache /var/tmp/cache; touch /tmp/cache/file /var/tmp/cache/file; chmod -R 0555 /tmp /var/tmp "$HOME"'],
            work, { PATH: '/usr/bin:/bin', HOME: home }, '', user, { workDir: work, files: { home, files: { fixture: 'orphan home' } } });
          let fixtureErrors = '';
          fixture.stderr.on('data', (b) => { fixtureErrors += b; });
          assert.equal((await once(fixture, 'close'))[0], 0, fixtureErrors);
          const paths = [join(dirname(work), 'tmp', 'cache', 'file'), join(dirname(work), 'var-tmp', 'cache', 'file'), join(home, 'fixture')];
          const canRead = () => userOperation(user, { op: 'check', paths }).paths.map((p: { read: boolean }) => p.read);
          assert.deepEqual(canRead(), [true, true, true]);

          // Leave the durable records in the state a killed daemon leaves behind.
          const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
            env: { ...process.env, SWARMBASE_CONFIG: configPath }, stdio: ['ignore', 'ignore', 'pipe'],
          });
          const exited = once(daemon, 'exit');
          let logs = '';
          daemon.stderr.on('data', (b) => { logs += b; });
          try {
            for (let i = 0; i < 300 && !logs.includes('listening on') && daemon.exitCode === null; i++) await delay(20);
            assert.match(logs, /listening on/);
            assert.match(logs, new RegExp(`run ${broken.id} orphan agent home cleanup failed`));
            const reloaded = new RunStore(dataDir, users);
            assert.equal(reloaded.get(orphan.id)?.status, 'interrupted');
            assert.equal(reloaded.get(broken.id)?.status, 'interrupted');
            assert.deepEqual(canRead(), [false, false, false]);
            assert.equal(statSync(work).uid, uid);
          } finally {
            daemon.kill();
            await exited;
          }
        } finally {
          userOperation(user, { op: 'remove', path: join(user.root, '.swarmbase', orphan.id) });
          userOperation(user, { op: 'remove', path: brokenDir });
        }
      });

      await t.test('cleanup refuses a redirected ancestor and unlinks an entry symlink', async () => {
        const fixture = spawnAgent('/bin/sh', ['-ec', 'mkdir -p target/work; touch target/work/sentinel; ln -s target redirect; ln -s target/work link'],
          cwd, { PATH: '/usr/bin:/bin', HOME: user.root }, '', user, { workDir: cwd });
        assert.equal((await once(fixture, 'close'))[0], 0);
        assert.throws(() => userOperation(user, { op: 'remove', path: join(cwd, 'redirect', 'work'), recreate: true }), /Not a directory/);
        assert.equal(userOperation(user, { op: 'remove', path: join(cwd, 'link'), recreate: true }), true);
        assert.equal(statSync(join(cwd, 'link')).isDirectory(), true);
        assert.equal(existsSync(join(cwd, 'target', 'work', 'sentinel')), true);
      });

      await t.test('launch refuses a caller-owned directory outside configured roots', async () => {
        const outside = `/tmp/swarmbase-outside-${meta.id}`;
        userOperation(user, { op: 'mkdir', path: outside });
        try {
          const outcome = await runClaudeAgent({ ...base(), cwd: outside }, new AbortController().signal, () => {});
          assert.equal(outcome.ok, false);
          assert.match(outcome.error ?? '', /cwd must be owned by caller and inside its configured roots/);
        } finally { userOperation(user, { op: 'remove', path: outside }); }
      });

      await t.test('cleanup uses the caller uid and preserves daemon records', () => {
        store.deleteWork(meta);
        assert.equal(existsSync(join(cwd, 'own.txt')), false);
        assert.equal(statSync(cwd).uid, uid);
        assert.ok(existsSync(join(meta.dir, 'meta.json')));
        assertNoAProcesses();
      });
    } finally {
      if (saved === undefined) delete process.env.DAEMON_SECRET; else process.env.DAEMON_SECRET = saved;
      await meter.stop();
      userOperation(user, { op: 'remove', path: join(user.root, '.swarmbase', meta.id) });
      rmSync(dataDir, { recursive: true, force: true });
    }
    function assertNoAProcesses(): void {
      let pids = '';
      try { pids = execFileSync('pgrep', ['-u', String(uid)], { encoding: 'utf8' }).trim(); }
      catch (e) { if ((e as { status: number }).status !== 1) throw e; }
      assert.equal(pids, '', `caller A processes remain: ${pids}`);
    }
  });
