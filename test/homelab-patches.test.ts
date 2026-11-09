import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mcplHttp } from '../src/listeners.js';
import { parseConfig } from '../src/config.js';
import { test } from 'node:test';
import { agentMcpFor, buildArgs, credentialEnv, denyRules, type ClaudeAgentSpec } from '../src/engines/claude.js';
import { buildAgentLaunch } from '../src/users.js';

test('OAuth is exclusive and caller secrets go through helper stdin, never sudo argv/env', () => {
  assert.deepEqual(credentialEnv({kind: 'authToken', value: 'private-oauth'}), { CLAUDE_CODE_OAUTH_TOKEN: 'private-oauth' });
  assert.deepEqual(credentialEnv({kind: 'apiKey', value: 'private-key'}), { ANTHROPIC_API_KEY: 'private-key' });
  const launch = buildAgentLaunch('/usr/bin/claude', ['-p'], '/srv/a/work', credentialEnv({kind: 'authToken', value: 'private-oauth'}), 'prompt',
    {user: 'swarm-a', root: '/home/swarm-a', helper: '/usr/local/libexec/swarmbase-user'},
    {home: '/home/swarm-a/run-home', files: {'agent-mcp.json': 'private-mcp', 'auth.json': 'private-codex'}});
  assert.doesNotMatch(JSON.stringify([launch.args, launch.env]), /private-/);
  assert.match(launch.input, /private-oauth/);
  assert.match(launch.input, /private-mcp/);
  assert.match(launch.input, /private-codex/);
});

test('MCP profile gating and explicit credential deny rules', () => {
  const m = {configPath: '/secrets/mcp.json', allowedTools: ['mcp__bosun__read'], profiles: ['read', 'write'] as ('read' | 'write')[]};
  assert.equal(agentMcpFor(m, 'think'), null);
  assert.deepEqual(agentMcpFor(m, 'read')?.allowedTools, m.allowedTools);
  const spec = {profile: 'read', cwd: '/work', model: 'fake', effort: null, schema: null, maxBudgetUsd: null,
    emptyMcpConfigPath: '/empty', agentMcp: m, dataDir: '/state', secretFiles: ['/secrets/mcp.json', '/secrets/a.oauth']} as unknown as ClaudeAgentSpec;
  assert.ok(buildArgs(spec).includes('--mcp-config=/secrets/mcp.json'));
  assert.ok(buildArgs(spec).some((a) => a.startsWith('--allowedTools=') && a.includes('mcp__bosun__read')));
  assert.ok(!buildArgs({...spec, profile:'think'}).join(' ').includes('mcp__bosun__read'));
  assert.ok(denyRules('/state', spec.secretFiles).includes('Read(//secrets/a.oauth)'));
});

test('TCP transport exposes health/metrics but refuses dashboard content even with a forged identity', async () => {
  const server = createServer(mcplHttp);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    for (const route of ['/', '/api/runs', '/run/other', '/api/run/other/events']) {
      const res = await fetch(url + route, {headers: {'Tailscale-User-Login':'misha'}});
      assert.equal(res.status, 404);
      assert.equal(await res.text(), 'not found\n');
    }
    assert.equal((await fetch(url + '/health')).status, 200);
    assert.match(await (await fetch(url + '/metrics')).text(), /swarmbase_up 1/);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
  assert.equal(parseConfig({dashboardSocket:'/run/private.sock'}).dashboardSocket, '/run/private.sock');
  assert.throws(() => parseConfig({dashboardSocket:'relative'}), /absolute Unix socket/);
});

test('shared workspace gid and caller concurrency controls are explicit and validated', () => {
  const caller = {name:'a', tokenSha256:'a'.repeat(64), apiKeyFile:'/secret', runAs:'swarm-a', cwdGid:22001, maxConcurrentAgents:2, perRunConcurrency:1};
  const c = parseConfig({callers:[caller] as never}).callers[0];
  assert.equal(c.cwdGid, 22001);
  assert.equal(c.maxConcurrentAgents, 2);
  assert.equal(c.perRunConcurrency, 1);
  assert.throws(() => parseConfig({callers:[{...caller, runAs:undefined}] as never}), /cwdGid/);
  assert.throws(() => parseConfig({callers:[{...caller, maxConcurrentAgents:0}] as never}), /positive integer/);
});
