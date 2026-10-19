/**
 * Per-caller agent MCP servers (claude engine): config validation, the claude
 * CLI args with and without them, profile gating (think never gets them), and
 * the deny rule for the config file.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig, type AgentMcp } from '../src/config.js';
import { agentMcpFor, buildArgs, denyRules, type ClaudeAgentSpec } from '../src/engines/claude.js';
import { guideText } from '../src/guide.js';

const caller = { name: 'r', tokenSha256: 'a'.repeat(64), apiKeyFile: '/tmp/x.key' };
const mcp = { configPath: '/etc/swarmbase/r-mcp.json', allowedTools: ['mcp__browser__navigate', 'mcp__browser__read'] };

function spec(over: Partial<ClaudeAgentSpec> = {}): ClaudeAgentSpec {
  return {
    runId: 'run1', n: 1, label: 'a', prompt: 'p', schema: null, model: 'claude-sonnet-5-5', effort: null, profile: 'read',
    cwd: '/w/run1/work', timeoutMs: 1000, maxBudgetUsd: null, streamPath: '/w/s.jsonl', apiKey: 'k', apiBaseUrl: null,
    claudeBin: 'claude', emptyMcpConfigPath: '/d/empty-mcp.json', agentMcp: null, dataDir: '/d', denyExtra: [], ...over,
  };
}

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

test('config: agentMcp is optional, defaults to read and write, and is validated', () => {
  assert.equal(parseConfig({ callers: [caller] } as any).callers[0].agentMcp, null);
  const c = parseConfig({ callers: [{ ...caller, agentMcp: { ...mcp, allowedTools: [...mcp.allowedTools, 'mcp__browser__read'] } }] } as any);
  assert.deepEqual(c.callers[0].agentMcp, { ...mcp, profiles: ['read', 'write'] }, 'tool names are deduplicated');
  const home = parseConfig({ callers: [{ ...caller, agentMcp: { ...mcp, configPath: '~/mcp.json', profiles: ['write'] } }] } as any);
  assert.equal(home.callers[0].agentMcp!.configPath, path.join(os.homedir(), 'mcp.json'));
  assert.deepEqual(home.callers[0].agentMcp!.profiles, ['write']);
  const bad = (agentMcp: unknown, re: RegExp, engines = ['claude']) =>
    assert.throws(() => parseConfig({ callers: [{ ...caller, engines, agentMcp }] } as any), re);
  bad({ ...mcp, configPath: 'mcp.json' }, /configPath must be an absolute path/);
  bad({ allowedTools: mcp.allowedTools }, /configPath must be an absolute path/);
  bad({ ...mcp, allowedTools: [] }, /allowedTools must list MCP tool names/);
  bad({ ...mcp, allowedTools: ['Bash'] }, /allowedTools must list MCP tool names/);
  bad({ ...mcp, allowedTools: ['mcp__browser__navigate,Bash'] }, /allowedTools must list MCP tool names/);
  bad({ ...mcp, profiles: ['think'] }, /profiles may name read and write only/);
  bad({ ...mcp, profiles: [] }, /profiles may name read and write only/);
  bad(mcp, /claude engine only/, ['claude', 'codex']);
});

test('buildArgs: without agentMcp the agent gets the empty MCP config and the profile tools only', () => {
  const args = buildArgs(spec());
  assert.equal(flag(args, 'mcp-config'), '/d/empty-mcp.json');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(flag(args, 'tools'), 'Read,Grep,Glob,WebFetch,WebSearch');
  assert.ok(!flag(args, 'allowedTools')!.includes('mcp__'));
});

test('buildArgs: with agentMcp the config replaces the empty one and its tools are offered and allowed', () => {
  const args = buildArgs(spec({ agentMcp: mcp }));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(flag(args, 'mcp-config'), mcp.configPath);
  assert.equal(flag(args, 'tools'), 'Read,Grep,Glob,WebFetch,WebSearch,mcp__browser__navigate,mcp__browser__read');
  assert.deepEqual(flag(args, 'allowedTools')!.split(',').slice(-2), mcp.allowedTools);
  // --mcp-config, --tools and --allowedTools are variadic: never a separate value argument
  assert.ok(!args.some((a) => ['--mcp-config', '--tools', '--allowedTools'].includes(a)));
});

test('profile gating: only the named profiles get the servers; think never does', () => {
  const m: AgentMcp = { ...mcp, profiles: ['write'] };
  assert.equal(agentMcpFor(null, 'write'), null);
  assert.equal(agentMcpFor(m, 'read'), null);
  assert.deepEqual(agentMcpFor(m, 'write'), mcp);
  assert.equal(agentMcpFor({ ...m, profiles: ['think' as any] }, 'think'), null);
  // even if a spec carried them, a think agent keeps no tools and the empty config
  const think = buildArgs(spec({ profile: 'think', agentMcp: mcp }));
  assert.equal(flag(think, 'mcp-config'), '/d/empty-mcp.json');
  assert.equal(flag(think, 'tools'), '');
  assert.equal(flag(think, 'allowedTools'), undefined);
});

test('deny rules: the agent MCP config files are denied by path', () => {
  assert.ok(denyRules('/d', ['/etc/swarmbase/r-mcp.json']).includes('Read(//etc/swarmbase/r-mcp.json)'));
  assert.ok(!denyRules('/d').some((r) => r.includes('mcp')));
  const settings = JSON.parse(flag(buildArgs(spec({ agentMcp: mcp, denyExtra: [mcp.configPath] })), 'settings')!);
  assert.ok(settings.permissions.deny.includes(`Read(/${mcp.configPath})`));
});

test('guide: names the MCP tools and the profiles that get them, only when configured', () => {
  const base = { defaultModel: 'm', engines: ['claude'], defaultModels: {}, maxProfile: 'write', budgetDefault: 5, budgetMax: 25, tokensDefault: 1, tokensMax: 1, maxAgents: 10, perRun: 4, cwdRoots: [] };
  assert.ok(!guideText(base).includes('MCP tools'));
  const g = guideText({ ...base, agentMcp: { ...mcp, profiles: ['read', 'write'] } });
  assert.match(g, /profile "read" or "write" also get these MCP tools:\s+`mcp__browser__navigate`, `mcp__browser__read`/);
});
