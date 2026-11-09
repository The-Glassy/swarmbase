// Real runner and real engine against a fake CLI: what a run's limits do, with nothing billed.
// A prompt of `sleep:<seconds>` makes the fake agent take that long.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseConfig, type Config, type CallerPolicy } from '../src/config.js';
import { denyRules, ensureEmptyMcpConfig } from '../src/engines/claude.js';
import { RunManager } from '../src/runs.js';
import { RunStore, type RunMeta } from '../src/store.js';
import { SwarmTools } from '../src/tools.js';
import type { Notifier } from '../src/notifier.js';

const root = mkdtempSync(join(tmpdir(), 'swarmbase-limits-'));
after(() => rmSync(root, { recursive: true, force: true }));

const argsLog = join(root, 'cli-args.log');
const fakeCli = join(root, 'fake-claude');
writeFileSync(fakeCli, `#!/bin/sh
echo "$*" >> '${argsLog}'
prompt=$(cat)
case "$prompt" in sleep:*) sleep "\${prompt#sleep:}";; esac
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0,"usage":{}}'
`);
chmodSync(fakeCli, 0o755);
const keyFile = join(root, 'key');
writeFileSync(keyFile, 'fake-key');

let dirs = 0;
function harness(limits: Partial<Config> = {}, callerLimits: Partial<CallerPolicy> = {}) {
  const dataDir = join(root, `data-${++dirs}`);
  const cfg = parseConfig({
    dataDir,
    engines: { claude: { bin: fakeCli, baseUrl: null } } as Config['engines'],
    callers: [{ name: 'nestor', tokenSha256: 'a'.repeat(64), apiKeyFile: keyFile, maxProfile: 'read', ...callerLimits }] as Config['callers'],
    ...limits,
  });
  const store = new RunStore(dataDir);
  const ended = new Map<string, () => void>();
  const runs = new RunManager(cfg, store, ensureEmptyMcpConfig(dataDir), { runEnded: (m: RunMeta) => ended.get(m.id)?.() });
  const start = (script: string, budgetUsd = 5) => {
    const meta = runs.start({ caller: cfg.callers[0], script, args: null, label: null, defaults: {}, budgetUsd, budgetTokens: 0, resumeFrom: null });
    const done = new Promise<void>((resolve) => ended.set(meta.id, resolve));
    return { meta, done };
  };
  return { cfg, store, runs, start };
}

/** The most agents that were running at the same moment, from the run's own event log. */
function peakConcurrency(store: RunStore, id: string): number {
  let now = 0;
  let peak = 0;
  for (const e of store.readEvents(id)) {
    if (e.type === 'agent_start') peak = Math.max(peak, ++now);
    if (e.type === 'agent_end') now--;
  }
  return peak;
}

const fanOut = (n: number, seconds: number) => `
const rs = await parallel(Array.from({ length: ${n} }, (_, i) => () => agent('sleep:${seconds}', { label: 'a' + i, profile: 'think', model: 'haiku' })));
return rs.filter((r) => r === 'ok').length;`;

test('the defaults: no per-agent timeout, 24 hours for a run', () => {
  const cfg = parseConfig({});
  assert.equal(cfg.agentTimeoutMs, null);
  assert.equal(cfg.runTimeoutMs, 24 * 3_600_000);
  assert.throws(() => parseConfig({ agentTimeoutMs: 0 }), /agentTimeoutMs/);
  assert.throws(() => parseConfig({ runTimeoutMs: 0 }), /runTimeoutMs/);
  // Each of these would otherwise throw when a run starts, after its record is written.
  for (const bad of ['86400000', Infinity, 1e30]) {
    assert.throws(() => parseConfig({ runTimeoutMs: bad as number }), /runTimeoutMs/, String(bad));
  }
});

test('a large budget does not hold a run to 8 agents at once', async () => {
  const { store, start } = harness({ perRunConcurrency: 20, maxConcurrentAgents: 20 });
  const { meta, done } = start(fanOut(12, 2), 10_000_000);
  await done;
  assert.equal(store.get(meta.id)?.status, 'completed');
  assert.equal(store.readResultText(meta.id), '12');
  assert.equal(peakConcurrency(store, meta.id), 12);
});

test('a default cap stops at the ceiling instead of growing with the budget', async () => {
  const { start } = harness();
  writeFileSync(argsLog, '');
  await start(fanOut(1, 0), 10_000_000).done;
  assert.match(readFileSync(argsLog, 'utf8'), /--max-budget-usd=10000\.00/);
});

test('a budget a caller names still keeps budget/8, so its agents are not starved', async () => {
  const { store, start } = harness({ perRunConcurrency: 1000, maxConcurrentAgents: 1000 });
  writeFileSync(argsLog, '');
  const { meta, done } = start(fanOut(10, 2), 1000);
  await done;
  assert.match(readFileSync(argsLog, 'utf8'), /--max-budget-usd=125\.00/);
  assert.equal(peakConcurrency(store, meta.id), 8);
  assert.equal(store.readResultText(meta.id), '10');
});

test('a configured agent timeout still stops an agent', async () => {
  const { store, start } = harness({ agentTimeoutMs: 300 });
  const { meta, done } = start(fanOut(1, 30));
  await done;
  assert.equal(store.get(meta.id)?.status, 'completed');
  assert.equal(store.readResultText(meta.id), '0');
  // Held until the timeout, rather than a CLI that failed to start.
  const end = store.readEvents(meta.id).find((e) => e.type === 'agent_end') as { durationMs: number };
  assert.ok(end.durationMs >= 250 && end.durationMs < 10_000, `ran ${end.durationMs} ms`);
});

test('a run fails at its deadline, and says so', async () => {
  const { store, start } = harness({ runTimeoutMs: 1500 });
  const { meta, done } = start(fanOut(1, 30));
  await done;
  const ended = store.get(meta.id)!;
  assert.equal(ended.status, 'failed');
  assert.match(ended.error ?? '', /reached its deadline/);
  assert.ok(store.readEvents(meta.id).some((e) => e.type === 'agent_start'), 'an agent was running when the deadline came');
});

test('extending keeps a run past its deadline, including past what one timer can wait', async () => {
  const { store, runs, start } = harness({ runTimeoutMs: 800 });
  const { meta, done } = start(fanOut(1, 2));
  const first = Date.parse(store.get(meta.id)!.deadlineAt!);
  const moved = runs.extendDeadline(meta.id, 1000 * 3_600_000); // ~41 days; a bare setTimeout would fire at once
  assert.equal(Date.parse(moved!), first + 1000 * 3_600_000);
  await done;
  const ended = store.get(meta.id)!;
  assert.equal(ended.status, 'completed');
  assert.equal(store.readResultText(meta.id), '1');
  assert.equal(ended.deadlineAt, moved);
  assert.ok(store.readEvents(meta.id).some((e) => e.type === 'log' && e.message.includes('deadline extended')));
});

test('the extend tool: only your own running run, by a sane amount, and status shows the deadline', async () => {
  const { cfg, store, runs, start } = harness();
  const tools = new SwarmTools(cfg, store, runs, { runUrl: () => null } as unknown as Notifier);
  const caller = cfg.callers[0];
  const { meta, done } = start(fanOut(1, 1));

  const before = Date.parse(store.get(meta.id)!.deadlineAt!);
  const moved = await tools.callTool(caller, 'extend', { runId: meta.id, hours: 2 });
  assert.ok(!moved.isError);
  assert.match(moved.content[0].text, /now has until/);
  assert.equal(Date.parse(store.get(meta.id)!.deadlineAt!), before + 2 * 3_600_000);
  assert.match((await tools.callTool(caller, 'status', { runId: meta.id })).content[0].text, new RegExp(`Deadline: ${store.get(meta.id)!.deadlineAt}`));

  const agreed = store.get(meta.id)!.deadlineAt;
  for (const hours of [0, -1, 'soon', Infinity, 2_000_000]) {
    assert.ok((await tools.callTool(caller, 'extend', { runId: meta.id, hours })).isError, String(hours));
  }
  const stranger = { ...caller, name: 'someone-else' };
  assert.ok((await tools.callTool(stranger, 'extend', { runId: meta.id, hours: 1 })).isError);
  assert.equal(store.get(meta.id)!.deadlineAt, agreed, 'a refused request changes nothing');

  await done;
  const late = await tools.callTool(caller, 'extend', { runId: meta.id, hours: 1 });
  assert.ok(late.isError);
  assert.match(late.content[0].text, /has ended or is ending/);
  assert.equal(store.get(meta.id)!.deadlineAt, agreed);
});

test('subagents can not fetch tailnet hosts', () => {
  assert.ok(denyRules('/data').includes('WebFetch(domain:*.ts.net)'));
});

test('caller agent ceiling spans runs and caller per-run ceiling overrides the global default', async () => {
  const {store, start} = harness({maxConcurrentAgents:12, perRunConcurrency:12}, {maxConcurrentAgents:1, perRunConcurrency:1});
  const a = start(fanOut(3, 0.15));
  const b = start(fanOut(3, 0.15));
  await Promise.all([a.done, b.done]);
  const events = [a, b].flatMap(({meta}) => store.readEvents(meta.id))
    .filter((e) => e.type === 'agent_start' || e.type === 'agent_end')
    .sort((a, b) => a.ts.localeCompare(b.ts) || (a.type === 'agent_end' ? -1 : 1));
  let now = 0, peak = 0;
  for (const e of events) { now += e.type === 'agent_start' ? 1 : -1; peak = Math.max(peak, now); }
  assert.equal(peak, 1, 'one caller cannot use another global slot through a second run');
  for (const {meta} of [a, b]) {
    assert.equal(store.get(meta.id)?.status, 'completed');
    assert.equal(peakConcurrency(store, meta.id), 1);
  }
});
