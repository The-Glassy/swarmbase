/**
 * `claude` engine — one headless `claude -p` process per agent() call
 * (--output-format stream-json --verbose, prompt on stdin), authenticated with
 * the caller's API key against the configured base URL. When the base URL is an
 * inference gateway, every request carries x-gate-* attribution headers
 * (origin=swarmbase, channel=<runId>, counterparty=<n:label>).
 *
 * Isolation (verified with CLI 2.1.287):
 *  - --strict-mcp-config + empty --mcp-config: no MCP servers.
 *  - --setting-sources= (empty): no user/project/local settings, so no hooks,
 *    plugins or env from the operator's config or from a settings dir an agent
 *    planted in its cwd.
 *  - --permission-mode=dontAsk + PATH-SCOPED allow rules: file tools work only
 *    under the agent's cwd (`Read(//<cwd>/**)` also governs Grep/Glob); anything
 *    else is denied. A plain `--allowedTools=Read` lets Read/Grep reach the whole
 *    disk — that was verified to leak a file outside the cwd, hence the scoping.
 *  - --settings deny rules for secrets as defense in depth.
 *  - minimal environment (nothing of the operator's is inherited).
 *  - `write` adds Bash, which is NOT path-confined: trusted callers only.
 *
 * Gotchas encoded here:
 *  - --mcp-config / --tools / --allowedTools are VARIADIC and swallow a
 *    following positional; always use the `--flag=value` form, prompt on stdin.
 *  - When --max-budget-usd trips, result.structured_output is null even if the
 *    StructuredOutput tool_use was emitted, so we harvest it from the stream.
 *  - A failed API call (e.g. unknown model) ends with subtype "success" + is_error.
 */
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createWriteStream, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from '../config.js';

export interface ClaudeAgentSpec {
  runId: string;
  n: number;
  label: string;
  prompt: string;
  schema: object | null;
  model: string;
  effort: string | null;
  profile: Profile;
  cwd: string;
  timeoutMs: number;
  maxBudgetUsd: number | null;
  streamPath: string;
  apiKey: string;
  apiBaseUrl: string | null;
  claudeBin: string;
  emptyMcpConfigPath: string;
  /** SwarmBase data dir (realpath), for the deny rules. */
  dataDir: string;
}

export interface AgentOutcome {
  ok: boolean;
  /** Structured object when a schema was given, else final text. */
  result: unknown;
  costUsd: number;
  durationMs: number;
  usage: unknown;
  error: string | null;
  /** Why the process ended when not ok: 'cancelled' | 'timeout' | 'exit' | 'result-error'. */
  reason: string | null;
}

export interface Activity { kind: 'text' | 'tool_use' | 'tool_result' | 'thinking'; summary: string }

const TOOLS: Record<Profile, string[]> = {
  think: [],
  read: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  write: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Edit', 'Write', 'Bash'],
};

/** Allow rules; `cwd` must be an absolute, symlink-resolved path. `//` = absolute in rule syntax. */
export function allowRules(profile: Profile, cwd: string): string[] {
  const root = `/${cwd.replace(/\/+$/, '')}/**`;
  if (profile === 'think') return [];
  const read = [`Read(${root})`, 'WebFetch', 'WebSearch'];
  return profile === 'read' ? read : [...read, `Edit(${root})`, `Write(${root})`, 'Bash'];
}

/** Deny rules (defense in depth — the allow rules already confine file tools to
 *  the cwd; these matter when a policy cwd root sits above something sensitive).
 *  Inside the SwarmBase data dir only the secrets and run metadata are denied: a
 *  blanket deny on the data dir would also cover runs/<id>/work, the default cwd,
 *  and deny beats allow (verified: the agent could not read its own work dir). */
export function denyRules(dataDir: string): string[] {
  const h = homedir();
  const d = dataDir.replace(/\/+$/, '');
  return [
    `Read(/${d}/*.token)`, `Read(/${d}/*.key)`, `Read(/${d}/config.json*)`, `Read(/${d}/outbox.json)`, `Read(/${d}/live-agents.json)`,
    ...['meta.json', 'events.jsonl', 'journal.jsonl', 'script.js', 'args.json', 'result.json', 'agents/**'].map((f) => `Read(/${d}/runs/*/${f})`),
    `Read(/${h}/.ssh/**)`, `Read(/${h}/.claude/**)`, `Read(/${h}/.claude.json)`,
    `Read(/${h}/.codex/**)`, `Read(/${h}/.portal/**)`, `Read(/${h}/.aws/**)`, `Read(/${h}/.config/**)`,
    'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.token)', 'Read(**/*credentials*)',
  ];
}

export interface Price { in: number; out: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }

/** Model price rows (USD / MTok), used only to estimate spend for agents that were
 *  killed before the CLI reported its own total. Longest prefix wins; unknown
 *  models are charged at the most expensive row (fail toward over-counting).
 *  config.prices adds to / overrides these. */
const PRICES: Record<string, Price> = {
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-sonnet-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-sonnet-4': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  'claude-opus-4': { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
};

export function addPrices(extra: Record<string, Price> | undefined): void {
  if (extra) Object.assign(PRICES, extra);
}

function priceCeiling(): Price {
  return Object.values(PRICES).reduce((a, b) => (b.out > a.out ? b : a));
}

export function estimateCost(model: string, u: Record<string, any>): number {
  let best = '';
  for (const k of Object.keys(PRICES)) if (model.startsWith(k) && k.length > best.length) best = k;
  const p = best ? PRICES[best] : priceCeiling();
  const w1h = Number(u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const wAll = Number(u.cache_creation_input_tokens ?? 0);
  return (Number(u.input_tokens ?? 0) * p.in + Number(u.output_tokens ?? 0) * p.out
    + Number(u.cache_read_input_tokens ?? 0) * p.cacheRead + (wAll - w1h) * p.cacheWrite + w1h * p.cacheWrite1h) / 1e6;
}

/** Process groups of live agent processes, mirrored to disk so a crashed daemon's
 *  orphans can be reaped on the next boot. */
const LIVE_GROUPS = new Set<number>();
let liveFile: string | null = null;

function persistLive(): void {
  if (!liveFile) return;
  try { writeFileSync(liveFile, JSON.stringify([...LIVE_GROUPS])); } catch { /* best effort */ }
}

export function killAllAgentGroups(sig: NodeJS.Signals = 'SIGKILL'): number {
  let n = 0;
  for (const pgid of LIVE_GROUPS) {
    try { process.kill(-pgid, sig); n++; } catch { /* gone */ }
  }
  return n;
}

/** Boot-time: remember where live groups go, and SIGKILL any recorded group whose
 *  leader is still a SwarmBase-launched claude (pid reuse is checked via ps). */
export function initLiveGroups(file: string, log: (s: string) => void): void {
  liveFile = file;
  let prior: number[] = [];
  try { prior = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none */ }
  for (const pgid of Array.isArray(prior) ? prior : []) {
    if (!Number.isInteger(pgid) || pgid <= 1) continue;
    let cmd = '';
    try { cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pgid)], { encoding: 'utf8' }); } catch { continue; }
    if (cmd.includes('claude') && cmd.includes('--output-format=stream-json')) {
      try { process.kill(-pgid, 'SIGKILL'); log(`reaped orphaned agent process group ${pgid}`); } catch { /* gone */ }
    }
  }
  persistLive();
}

export function ensureEmptyMcpConfig(dataDir: string): string {
  const p = join(dataDir, 'empty-mcp.json');
  if (!existsSync(p)) writeFileSync(p, JSON.stringify({ mcpServers: {} }));
  return p;
}

export function readApiKey(file: string): string {
  const t = readFileSync(file, 'utf8').trim();
  if (!t) throw new Error(`API key file ${file} is empty`);
  return t;
}

/** Header values: printable ASCII only (non-Latin-1 chars would make undici reject
 *  every request); gate trims/caps them again on its side. */
function headerSafe(v: string): string {
  return v.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

export function buildArgs(spec: ClaudeAgentSpec): string[] {
  const tools = TOOLS[spec.profile];
  const args = [
    '-p',
    '--output-format=stream-json',
    '--verbose',
    `--model=${spec.model}`,
    '--no-session-persistence',
    '--strict-mcp-config',
    `--mcp-config=${spec.emptyMcpConfigPath}`,
    '--setting-sources=',
    `--settings=${JSON.stringify({ permissions: { deny: denyRules(spec.dataDir) } })}`,
    '--permission-mode=dontAsk',
    `--tools=${tools.join(',')}`,
  ];
  const allow = allowRules(spec.profile, spec.cwd);
  if (allow.length) args.push(`--allowedTools=${allow.join(',')}`);
  if (spec.effort) args.push(`--effort=${spec.effort}`);
  if (spec.schema) args.push(`--json-schema=${JSON.stringify(spec.schema)}`);
  if (spec.maxBudgetUsd !== null) args.push(`--max-budget-usd=${Math.max(0.01, spec.maxBudgetUsd).toFixed(2)}`);
  return args;
}

export function runClaudeAgent(spec: ClaudeAgentSpec, signal: AbortSignal, onActivity: (a: Activity) => void): Promise<AgentOutcome> {
  const started = Date.now();
  // Minimal environment: nothing of the operator's is inherited beyond what the CLI needs.
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  env.ANTHROPIC_API_KEY = spec.apiKey;
  if (spec.apiBaseUrl) {
    env.ANTHROPIC_BASE_URL = spec.apiBaseUrl;
    // attribution for a gateway ledger; stripped by the gateway before upstream
    env.ANTHROPIC_CUSTOM_HEADERS = [
      'x-gate-origin: swarmbase',
      `x-gate-channel: ${headerSafe(spec.runId)}`,
      `x-gate-counterparty: ${headerSafe(`${spec.n}:${spec.label}`)}`,
      'x-gate-tags: swarmbase',
    ].join('\n');
  }
  env.DISABLE_AUTOUPDATER = '1';

  const out = createWriteStream(spec.streamPath, { flags: 'a' });
  const child = spawn(spec.claudeBin, buildArgs(spec), {
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // own process group, so tools it spawned die with it
  });

  if (child.pid !== undefined) { LIVE_GROUPS.add(child.pid); persistLive(); }
  let resultEvent: Record<string, unknown> | null = null;
  let harvested: unknown = undefined;
  let lastText = '';
  const usageByMsg = new Map<string, Record<string, any>>();
  let actualModel: string | null = null;
  let stderrTail = '';
  let endReason: string | null = null;

  const killGroup = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, sig); } catch { /* already gone */ }
  };
  const stop = (why: string) => {
    if (endReason) return;
    endReason = why;
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), 5000).unref();
  };
  const onAbort = () => stop('cancelled');
  if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('timeout'), spec.timeoutMs);

  child.stdin.on('error', () => { /* child died before reading the prompt */ });
  child.stdin.end(spec.prompt);

  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    out.write(chunk);
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let e: Record<string, any>;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'result') resultEvent = e;
      else if (e.type === 'system' && e.subtype === 'init' && typeof e.model === 'string') actualModel = e.model;
      else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        if (e.message.id && e.message.usage) usageByMsg.set(String(e.message.id), e.message.usage);
        for (const b of e.message.content) {
          if (b.type === 'text' && b.text) { lastText = b.text; onActivity({ kind: 'text', summary: clip(b.text, 160) }); }
          else if (b.type === 'thinking') onActivity({ kind: 'thinking', summary: '…' });
          else if (b.type === 'tool_use') {
            if (b.name === 'StructuredOutput') harvested = b.input;
            onActivity({ kind: 'tool_use', summary: clip(`${b.name} ${JSON.stringify(b.input ?? {})}`, 160) });
          }
        }
      } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
        for (const b of e.message.content) {
          if (b?.type === 'tool_result') {
            const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
            onActivity({ kind: 'tool_result', summary: clip((b.is_error ? 'ERROR ' : '') + c, 160) });
          }
        }
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });

  return new Promise<AgentOutcome>((resolve) => {
    let settled = false;
    const finish = (code: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) { LIVE_GROUPS.delete(child.pid); persistLive(); }
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      out.end();
      const durationMs = Date.now() - started;
      const r = resultEvent as Record<string, any> | null;
      // The CLI's own total when it got to report one; otherwise (killed,
      // crashed) an estimate from the per-message usage it streamed.
      let estimated = 0;
      for (const u of usageByMsg.values()) estimated += estimateCost(actualModel ?? spec.model, u);
      const costUsd = typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : estimated;
      const usage = r?.usage ?? null;

      if (endReason === 'cancelled' || endReason === 'timeout') {
        resolve({ ok: false, result: null, costUsd, durationMs, usage, error: endReason, reason: endReason });
        return;
      }
      if (spawnError) {
        resolve({ ok: false, result: null, costUsd, durationMs, usage, error: `spawn failed: ${spawnError.message}`, reason: 'exit' });
        return;
      }
      if (r && r.subtype === 'success' && !r.is_error) {
        const result = spec.schema ? (r.structured_output ?? harvested ?? null) : (r.result ?? lastText);
        if (spec.schema && result === null) {
          resolve({ ok: false, result: null, costUsd, durationMs, usage, error: 'no structured output produced', reason: 'result-error' });
          return;
        }
        resolve({ ok: true, result, costUsd, durationMs, usage, error: null, reason: null });
        return;
      }
      // Errored result (budget, max turns, execution error): keep a schema'd
      // answer if the model already delivered one.
      if (spec.schema && harvested !== undefined) {
        resolve({ ok: true, result: harvested, costUsd, durationMs, usage, error: null, reason: null });
        return;
      }
      // A failed API call still ends with subtype "success" + is_error; name it for what it is.
      const kind = r ? (r.subtype === 'success' ? 'api_error' : String(r.subtype ?? 'error')) : '';
      const why = r ? `${kind}${r.result ? `: ${clip(String(r.result), 300)}` : ''}` : `exit ${code}; ${clip(stderrTail, 400)}`;
      resolve({ ok: false, result: null, costUsd, durationMs, usage, error: why, reason: r ? 'result-error' : 'exit' });
    };
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
  });
}
