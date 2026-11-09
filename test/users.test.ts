import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, type ChildProcessWithoutNullStreams, type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.js';
import { buildArgs as codexArgs, bwrapArgs, type CodexAgentSpec } from '../src/engines/codex.js';
import { PINNED_CWD, assertNoCallerAccess, buildAgentLaunch, helperCommand, initializeCallerUsers, protectedParents, signalAgent, spawnAgent, type CallerUser } from '../src/users.js';

const caller = { name: 'a', tokenSha256: 'a'.repeat(64), apiKeyFile: '/keys/a' };
const user: CallerUser = { user: 'swarm-a', root: '/home/swarm-a', helper: '/usr/local/libexec/swarmbase-user' };

test('runAs config is opt-in; home defaults at Linux startup, legacy callers stay unchanged', () => {
  const legacy = parseConfig({ callers: [caller] as never }).callers[0];
  assert.equal(legacy.runAs, undefined);
  assert.equal(legacy.homeDir, undefined);
  const cfg = parseConfig({ callers: [{ ...caller, runAs: 'swarm-a' }] as never });
  assert.equal(cfg.callers[0].runAs, 'swarm-a');
  assert.equal(cfg.callers[0].homeDir, undefined);
  assert.equal(cfg.userHelper, user.helper);
  assert.equal(parseConfig({ callers: [{ ...caller, runAs: 'swarm-a', homeDir: '/srv/a' }] as never }).callers[0].homeDir, '/srv/a');
  assert.equal(initializeCallerUsers(parseConfig({})).size, 0);
});

test('runAs config rejects root, options, bad types and relative or orphaned homeDir', () => {
  for (const runAs of ['root', '', '-u', 'a b', '0', '../a', 12, null]) {
    assert.throws(() => parseConfig({ callers: [{ ...caller, runAs }] as never }), /runAs/);
  }
  for (const homeDir of ['relative', '~/.home', 1, null]) {
    assert.throws(() => parseConfig({ callers: [{ ...caller, runAs: 'a', homeDir }] as never }), /homeDir/);
  }
  assert.throws(() => parseConfig({ callers: [{ ...caller, homeDir: '/srv/a' }] as never }), /homeDir/);
  assert.throws(() => parseConfig({ userHelper: 'relative' }), /userHelper/);
});

test('privilege helper argument building: fixed sudo command, caller identity, no shell or env in argv', () => {
  assert.deepEqual(helperCommand(user), { command: '/usr/bin/sudo', args: ['-n', '-u', 'swarm-a', '--', user.helper] });
  const saved = process.env.DAEMON_SECRET;
  process.env.DAEMON_SECRET = 'other-caller-token';
  try {
    const plan = buildAgentLaunch('/usr/bin/claude', ['--tools=Bash', 'literal;$(id)'], '/home/swarm-a/work',
      { HOME: '/home/swarm-a/temp', ANTHROPIC_API_KEY: 'own-key' }, 'hello\nworld', user);
    assert.equal(plan.cwd, '/');
    assert.equal(plan.keepOpen, true);
    assert.deepEqual(plan.env, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
    assert.doesNotMatch(JSON.stringify(plan.args), /own-key|other-caller-token/);
    const payload = JSON.parse(plan.input);
    assert.equal(payload.env.ANTHROPIC_API_KEY, 'own-key');
    assert.equal(payload.env.DAEMON_SECRET, undefined);
    assert.equal(payload.prompt, 'hello\nworld');
    assert.deepEqual(payload.args, ['--tools=Bash', 'literal;$(id)']);
  } finally {
    if (saved === undefined) delete process.env.DAEMON_SECRET; else process.env.DAEMON_SECRET = saved;
  }
});

test('codex outer bubblewrap is the helper command child, including staged caller-only bearer/config files', () => {
  const plan = buildAgentLaunch('bwrap', ['--unshare-user', '--', '/usr/bin/codex', 'exec'], '/home/swarm-a/work',
    { CODEX_HOME: '/home/swarm-a/1-home' }, 'prompt', user,
    { home: '/home/swarm-a/1-home', files: { 'config.toml': 'bearer=per-agent-token' } });
  const payload = JSON.parse(plan.input);
  assert.equal(payload.command, 'bwrap');
  assert.deepEqual(payload.args.slice(-2), ['/usr/bin/codex', 'exec']);
  assert.equal(payload.files.files['config.toml'], 'bearer=per-agent-token');
  assert.doesNotMatch(JSON.stringify(plan.args), /per-agent-token/);
});

test('legacy spawn plan retains command, cwd, env and finite prompt stdin', () => {
  const env = { HOME: '/old-home', PATH: '/old-path' };
  assert.deepEqual(buildAgentLaunch('claude', ['-p'], '/work', env, 'prompt'), {
    command: 'claude', args: ['-p'], cwd: '/work', env, input: 'prompt', keepOpen: false,
  });
});

test('isolated codex uses the pinned cwd for both the outer mount and CLI chdir', () => {
  const s = { callerUser: user, cwd: '/home/swarm-a/work', homeDir: '/home/swarm-a/1-home', profile: 'write',
    codexBin: '/usr/bin/codex', model: 'fake', extraRoBinds: [] } as unknown as CodexAgentSpec;
  const outer = bwrapArgs(s, {});
  const pinned = outer.indexOf(PINNED_CWD);
  assert.equal(outer[pinned - 1], '--bind-fd');
  assert.equal(outer[pinned + 1], s.cwd);
  const cli = codexArgs(s, null);
  assert.equal(cli[cli.indexOf('-C') + 1], '.');
  assert.ok(!cli.includes(s.cwd));
  const read = bwrapArgs({ ...s, profile: 'read' }, {});
  assert.equal(read[read.indexOf(PINNED_CWD) - 1], '--ro-bind-fd');
});

test('startup access validation refuses read, write or traversal, including ACL/group access; gives fixes', () => {
  const entry = { path: '/home/b', read: false, write: false, execute: false, directory: true };
  assert.doesNotThrow(() => assertNoCallerAccess(user, [entry]));
  for (const bit of ['read', 'write', 'execute']) {
    assert.throws(() => assertNoCallerAccess(user, [{ ...entry, [bit]: true }]), /swarm-a.*\/home\/b.*setfacl.*chmod 0700/);
  }
  assert.throws(() => assertNoCallerAccess(user, [{ ...entry, directory: false, read: true, path: '/b.key' }]), /chmod 0600/);
});

test('mocked privilege helper receives explicit payload and cancellation over the existing pipe', () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let input = '';
  child.stdin.on('data', (b) => { input += String(b); });
  const mock = ((command: string, args: string[], opts: any) => {
    assert.equal(command, '/usr/bin/sudo');
    assert.deepEqual(args, helperCommand(user).args);
    assert.equal(opts.cwd, '/');
    assert.equal(opts.detached, true);
    assert.deepEqual(opts.env, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
    return child;
  }) as unknown as typeof spawn;
  const launched = spawnAgent('claude', ['-p'], '/home/swarm-a/work', { HOME: '/home/swarm-a', ANTHROPIC_API_KEY: 'only-a' }, 'prompt', user, undefined, mock);
  assert.equal(launched, child);
  assert.equal(child.stdin.writableEnded, false, 'pipe lifetime is the supervisor lifetime');
  const request = JSON.parse(input);
  assert.equal(request.env.ANTHROPIC_API_KEY, 'only-a');
  assert.deepEqual(request.roots, ['/home/swarm-a']);
  input = '';
  signalAgent(launched as ChildProcessWithoutNullStreams, 'SIGTERM');
  signalAgent(launched as ChildProcessWithoutNullStreams, 'SIGKILL');
  assert.equal(input, 'TERM\nKILL\n');
  child.stdin.destroy();
});

test('protected ancestor checks include every parent and deduplicate shared parents', () => {
  assert.deepEqual(new Set(protectedParents(['/__swarmbase_test__/private/config.json', '/__swarmbase_test__/private/a.key', '/__swarmbase_other__/b'])),
    new Set(['/__swarmbase_test__/private', '/__swarmbase_test__', '/', '/__swarmbase_other__']));
});

test('protected ancestor checks follow key symlinks and intermediate symlinks, even for missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-protected-'));
  try {
    mkdirSync(join(dir, 'safe'));
    mkdirSync(join(dir, 'caller'));
    mkdirSync(join(dir, 'caller', 'nested'));
    writeFileSync(join(dir, 'caller', 'nested', 'key'), 'test');
    symlinkSync(join(dir, 'caller', 'nested', 'key'), join(dir, 'safe', 'key'));
    symlinkSync(join(dir, 'caller', 'nested'), join(dir, 'safe', 'alias'));
    for (const file of ['key', 'alias/key', 'alias/future-key']) {
      assert.ok(protectedParents([join(dir, 'safe', file)]).includes(realpathSync(join(dir, 'caller'))), file);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('helper filesystem operations use current unprivileged uid, private modes and symlink-safe removal',
  { skip: process.getuid?.() === 0 || !['linux', 'darwin'].includes(process.platform) }, () => {
    const helper = fileURLToPath(new URL('../../scripts/swarmbase-user', import.meta.url));
    // Compiled tests live in dist/test; source tests live in test.
    const path = helper.includes('/dist/scripts/') ? helper.replace('/dist/scripts/', '/scripts/') : helper;
    const dir = mkdtempSync(join(tmpdir(), 'sb-user-helper-'));
    const request = (payload: object) => JSON.parse(execFileSync('/usr/bin/python3', ['-I', path], {
      input: JSON.stringify(payload) + '\n', encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
    }));
    try {
      const work = join(dir, 'work');
      assert.equal(request({ op: 'mkdir', path: work }), true);
      assert.equal(statSync(work).mode & 0o777, 0o750);
      assert.equal(statSync(work).uid, process.getuid!());
      const info = request({ op: 'check', paths: [work] });
      assert.equal(info.uid, process.getuid!());
      assert.equal(info.paths[0].write, true);
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'precious'), 'preserved');
      symlinkSync(outside, join(work, 'link'));
      request({ op: 'remove', path: work, recreate: true });
      assert.equal(readFileSync(join(outside, 'precious'), 'utf8'), 'preserved');
      assert.equal(statSync(work).uid, process.getuid!());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
