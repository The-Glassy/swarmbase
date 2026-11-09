/** Real kernel checks. See scripts/setup-test-users.sh; never uses paid APIs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { ensureEmptyMcpConfig, runClaudeAgent, type ClaudeAgentSpec } from '../src/engines/claude.js';
import { runCodexAgent } from '../src/engines/codex.js';
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
    writeFileSync(configPath, '{}', { mode: 0o600 });
    const cfg = parseConfig({
      dataDir, configPath,
      engines: { claude: { bin: '/usr/local/libexec/swarmbase-test-agent' },
        codex: { baseUrl: 'http://127.0.0.1:1', bin: '/usr/local/libexec/swarmbase-test-agent', sandbox: 'none' } } as never,
      callers: ['a', 'b'].map((name) => ({ name, tokenSha256: name.repeat(64), apiKeyFile: join(dataDir, `${name}.key`),
        runAs: `swarmbase-test-${name}`, engines: ['claude', 'codex'], maxProfile: 'write',
        cwdRoots: [`/home/swarmbase-test-${name}/projects`] })) as never,
    });
    const users = initializeCallerUsers(cfg);
    const store = new RunStore(dataDir, users);
    const user = users.get('a')!;
    const uid = Number(execFileSync('id', ['-u', user.user], { encoding: 'utf8' }).trim());
    const meta = store.create({ caller: 'a', label: null, script: '', args: null, defaults: {}, budgetUsd: 1, budgetTokens: 1, resumedFrom: null });
    const cwd = store.workDir(meta);
    const probe = JSON.stringify({ action: 'probe', otherKey: join(dataDir, 'b.key'), otherRoot: '/home/swarmbase-test-b/projects' });
    let n = 0;
    const base = (): ClaudeAgentSpec => ({ runId: meta.id, n: ++n, label: 'probe', prompt: probe, schema: null, model: 'fake',
      effort: null, profile: 'write', cwd, timeoutMs: 10_000, maxBudgetUsd: null, streamPath: store.agentStreamPath(meta, n),
      apiKey: 'test-key-a', apiBaseUrl: null, claudeBin: '/usr/local/libexec/swarmbase-test-agent',
      emptyMcpConfigPath: '/never-read-daemon-mcp', dataDir, callerUser: user, homeDir: store.agentHomeDir(meta, n) });
    const meter = new UsageMeter();
    await meter.start();
    const saved = process.env.DAEMON_SECRET;
    process.env.DAEMON_SECRET = 'B-TOKEN-MUST-NOT-LEAK';
    try {
      await t.test('startup checks use real caller accounts and reject accessible cross-caller paths', () => {
        const publicKey = join('/tmp', `swarmbase-public-${meta.id}.key`);
        writeFileSync(publicKey, 'public-test-key', { mode: 0o644 });
        try {
          const bad = { ...cfg, callers: cfg.callers.map((c) => c.name === 'b' ? { ...c, apiKeyFile: publicKey } : c) };
          assert.throws(() => initializeCallerUsers(bad), /can access.*swarmbase-public.*chmod 0600/);
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

      for (const sandbox of ['none', 'bwrap'] as const) for (const profile of ['write', 'read', 'think'] as const) await t.test(`codex ${profile}, ${sandbox}: CLI and outer wrapper run as A`, async () => {
        const s = base();
        const outcome = await runCodexAgent({ ...s, homeDir: s.homeDir!, maxTokens: 1000,
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
          { PATH: '/usr/bin:/bin', HOME: user.root }, '{"action":"hold"}', user);
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
