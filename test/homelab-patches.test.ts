import assert from 'node:assert/strict';
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
