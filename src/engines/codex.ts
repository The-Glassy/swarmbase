/**
 * `codex` engine — one `codex exec --json` process per agent() call, pointed
 * through the daemon's UsageMeter at the configured Responses endpoint (an
 * inference gateway's codex leg). Same contract as the claude engine:
 * AgentOutcome, activity events, process-group kill.
 *
 * Isolation (measured with codex-cli 0.158):
 *  - The CLI's own sandbox confines WRITES to the workspace but reads the whole
 *    disk: `-s read-only` let a command read a file beside the workspace. A
 *    named permission profile with `filesystem` deny entries does block reads,
 *    but only as a deny-list (denying an ancestor of the workspace breaks the
 *    sandbox; denying `/` breaks exec), and the `-s` flag silently REPLACES
 *    that profile. So: `default_permissions` in a throwaway CODEX_HOME, never
 *    `-s`, with deny entries for the daemon's secrets and the usual credential
 *    dirs — and, by default, an OUTER bubblewrap allow-list around the whole
 *    CLI that mounts only /usr (+ the usual symlinks), a few /etc files, the
 *    agent's cwd and its throwaway CODEX_HOME. The CLI's inner sandbox nests
 *    inside it (verified). `sandbox: "none"` leaves the deny-list alone.
 *  - A throwaway CODEX_HOME per agent: config, auth (none: the meter bearer is
 *    a provider header), logs, sqlite state. Deleted when the agent ends.
 *    `--ephemeral` keeps rollouts off disk; `--ignore-rules` skips execpolicy
 *    files a workspace could plant; the workspace is never trusted, so a
 *    `.codex/` dir in it is ignored.
 *  - Tools per profile: think = none (`shell_tool`, `unified_exec`, web search
 *    off); read = shell under `:read-only` with NO network (the outer wrapper
 *    shares the host's network namespace, so a shell with network would reach
 *    every loopback service on the host, this daemon's dashboard included),
 *    plus the CLI's web search; write = shell under `:workspace` with network
 *    (trusted callers only, like the claude engine's Bash). Sub-agents, goals,
 *    image viewing and user-input requests are off everywhere (the image tool
 *    reads files from the CLI process, outside its sandbox).
 *  - Budget: the CLI reports usage only in `turn.completed`, and an exec run
 *    is one turn, so the meter prices every response as it passes: the agent
 *    is stopped when its token ceiling (opts.maxTokens, clamped by the daemon
 *    and reserved from the run's token budget) or, when a price row exists for
 *    the model, its USD cap is crossed. Overshoot is bounded by one response.
 *    Without a price row the agent costs $0 and the token budget is the limit
 *    (the ChatGPT backend is subscription-metered). When the meter saw no
 *    usage (a response it could not parse), the CLI's own `turn.completed`
 *    count is used instead.
 *
 * Gotchas:
 *  - Prompt on stdin (`-`); with a prompt argument and a non-TTY stdin the CLI
 *    waits for stdin.
 *  - `--output-schema` makes the final message strict JSON; harvest it from
 *    the last `agent_message` item.
 *  - `item.type: "error"` items are advisory ("model metadata not found"):
 *    a run fails on `turn.failed`, `error`, or a non-zero exit only.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { Profile } from '../config.js';
import { estimateCost, KILL_GRACE_MS, priceFor, trackAgentGroup, untrackAgentGroup, type Activity, type AgentOutcome } from './claude.js';
import type { Usage, UsageMeter } from '../meter.js';

export interface CodexAgentSpec {
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
  maxTokens: number;
  streamPath: string;
  /** Throwaway CODEX_HOME for this agent (created and deleted here). */
  homeDir: string;
  /** The caller's gateway token, held by the meter, never by the CLI. */
  apiKey: string;
  /** Responses endpoint, e.g. https://gate/codex */
  baseUrl: string;
  codexBin: string;
  sandbox: 'bwrap' | 'none';
  extraRoBinds: string[];
  /** SwarmBase data dir (realpath), for the deny rules. */
  dataDir: string;
  /** Files outside the data dir that hold this caller's secrets (its apiKeyFile,
   *  the daemon's config file): denied by path. */
  denyExtra: string[];
}

export interface CodexOutcome extends AgentOutcome {
  /** No price row matched the model: costUsd is 0, not an estimate. */
  unpriced: boolean;
  tokens: number;
}

const PROFILE_NAMES: Record<Profile, string> = { think: 'swarm-think', read: 'swarm-read', write: 'swarm-write' };

function tomlStr(s: string): string {
  return JSON.stringify(s); // TOML basic strings share JSON's escapes for what we emit
}

/** Deny entries for the CLI's permission profile (a deny-list: the outer
 *  wrapper is the allow-list, and under `sandbox: "none"` this list is the
 *  only read barrier). Mirrors the claude engine's deny rules: the daemon's
 *  secrets and run records, every agent's CODEX_HOME (a sibling's config.toml
 *  holds its meter bearer), the caller's own key file and the config file,
 *  `.env`/token/credential files under the workspace, and the usual credential dirs. */
export function denyPaths(dataDir: string, homeDir: string, extra: string[] = [], cwd: string | null = null): string[] {
  const h = homedir();
  const d = dataDir.replace(/\/+$/, '');
  // A Set: the CLI's TOML parser refuses a duplicate key, and the config file
  // usually sits inside the data dir. Never an ancestor of the workspace or
  // the agent's home: the CLI's sandbox denies a directory by mounting over
  // it, and the agent's own files then sit on a read-only mount (the data dir
  // itself is usually ~/.swarmbase, so no entry for it: its files are listed).
  const roots = [cwd, homeDir].filter((r): r is string => !!r).map((r) => r.replace(/\/+$/, ''));
  const ancestorOfRoot = (p: string) => !/[*?[]/.test(p) && roots.some((r) => r === p || r.startsWith(p + '/'));
  return [...new Set([
    `${d}/*.token`, `${d}/*.key`, `${d}/config.json`, `${d}/config.json.*`, `${d}/outbox.json`, `${d}/live-agents.json`,
    ...runRecordPaths(d),
    `${homeDir}/config.toml`, // the meter bearer; the dir itself stays readable so `bash -l` finds an (absent) rc file quietly
    ...extra,
    // the CLI expands globs into mounts when the session starts, so they need a directory prefix: the workspace
    ...(cwd ? ['.env', '.env.*', '*.token', '*credentials*'].map((g) => `${cwd.replace(/\/+$/, '')}/**/${g}`) : []),
    `${h}/.ssh`, `${h}/.claude`, `${h}/.claude.json`, `${h}/.codex`, `${h}/.aws`, `${h}/.config`, `${h}/.gnupg`,
    `${h}/.netrc`, `${h}/.git-credentials`, `${h}/.npmrc`, `${h}/.docker`, `${h}/.kube`, `${h}/.portal`,
  ])].filter((p) => !ancestorOfRoot(p));
}

const RUN_RECORDS = ['meta.json', 'events.jsonl', 'journal.jsonl', 'script.js', 'args.json', 'result.json'];

/**
 * Every run's records and agent files, one exact entry each (plus `agents/*`
 * and `agents/**\/config.toml` per run), enumerated when the agent starts.
 * Glob shapes differ between CLI versions — 0.158 expands a `*` directory
 * component, 0.162 does not; 0.162 denies an explicit directory, 0.158 fails
 * on one — while exact paths, a `*` in the last component and `**` (with
 * `glob_scan_max_depth`) work on both. Globs are expanded when the session
 * starts anyway, so listing the directory then loses nothing.
 */
export function runRecordPaths(dataDir: string): string[] {
  const out: string[] = [];
  const runs = join(dataDir, 'runs');
  let names: string[] = [];
  try { names = readdirSync(runs); } catch { return out; }
  for (const name of names) {
    const run = join(runs, name);
    for (const f of RUN_RECORDS) if (existsSync(join(run, f))) out.push(join(run, f));
    out.push(`${run}/agents/*`, `${run}/agents/**/config.toml`);
  }
  return out;
}

/** Keywords whose value is a map of schemas, a list of schemas, or one schema. */
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const SCHEMA_ONE = new Set(['items', 'not', 'if', 'then', 'else', 'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'contains']);

function isObjectSchema(s: Record<string, unknown>): boolean {
  return s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object')) || ('properties' in s && s.type === undefined);
}

/** Walk a schema's subschemas (not its data: `enum`, `const`, `default` and
 *  `examples` are left alone), rebuilding each object schema with `f`. */
function mapSchema(schema: unknown, f: (s: Record<string, unknown>, at: string) => Record<string, unknown>, at = '#'): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (SCHEMA_MAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      const sub: Record<string, unknown> = {};
      for (const [name, def] of Object.entries(v as Record<string, unknown>)) sub[name] = mapSchema(def, f, `${at}/${k}/${name}`);
      out[k] = sub;
    } else if (SCHEMA_LISTS.has(k) && Array.isArray(v)) {
      out[k] = v.map((def, i) => mapSchema(def, f, `${at}/${k}/${i}`));
    } else if (SCHEMA_ONE.has(k) && v && typeof v === 'object') {
      out[k] = mapSchema(v, f, `${at}/${k}`);
    } else out[k] = v;
  }
  return f(out, at);
}

/**
 * The Responses API validates `--output-schema` as a strict schema: every object
 * must carry `additionalProperties: false` (the claude engine never cared). Add
 * it wherever a script's schema left it out, recursively, touching nothing else.
 */
export function strictSchema(schema: unknown): unknown {
  return mapSchema(schema, (s) => (isObjectSchema(s) && s.additionalProperties === undefined ? { ...s, additionalProperties: false } : s));
}

/**
 * What strict mode will reject, found before the agent starts (the backend's
 * answer would be a 400, which the script sees as `null`): an object whose
 * properties aren't all `required`, or one that allows extra properties.
 * Returns a message, or null when the schema is strict-compatible.
 */
export function strictSchemaProblem(schema: unknown): string | null {
  let problem: string | null = null;
  mapSchema(schema, (s, at) => {
    if (problem || !isObjectSchema(s)) return s;
    if (s.additionalProperties !== undefined && s.additionalProperties !== false) problem = `${at}: additionalProperties must be false (or omitted) for engine "codex"`;
    const props = Object.keys((s.properties ?? {}) as object);
    const required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
    const missing = props.filter((p) => !required.has(p));
    if (!problem && missing.length) problem = `${at}: every property must be listed in required for engine "codex" (missing: ${missing.join(', ')}); make an optional field nullable instead`;
    return s;
  });
  return problem;
}

/** The agent's CODEX_HOME/config.toml. */
export function renderConfig(spec: CodexAgentSpec, meter: { baseUrl: string; bearer: string }): string {
  const deny = denyPaths(spec.dataDir, spec.homeDir, spec.denyExtra, spec.cwd).map((p) => `${tomlStr(p)} = "deny"`).join('\n');
  const lines = [
    `model = ${tomlStr(spec.model)}`,
    'model_provider = "swarmbase"',
    `default_permissions = ${tomlStr(PROFILE_NAMES[spec.profile])}`,
    ...(spec.effort ? [`model_reasoning_effort = ${tomlStr(spec.effort)}`] : []),
    'approval_policy = "never"',
    'web_search = ' + (spec.profile === 'think' ? '"disabled"' : '"cached"'),
    '',
    '[history]',
    'persistence = "none"',
    '',
    '[features]',
    'multi_agent = false',
    'view_image = false',
    'goals = false',
    ...(spec.profile === 'think' ? ['shell_tool = false', 'unified_exec = false'] : []),
    '',
    '[agents]',
    'enabled = false',
    '',
    '[tools.experimental_request_user_input]',
    'enabled = false',
    '',
    '[model_providers.swarmbase]',
    'name = "SwarmBase meter"',
    `base_url = ${tomlStr(meter.baseUrl)}`,
    'wire_api = "responses"',
    `http_headers = { "authorization" = ${tomlStr(`Bearer ${meter.bearer}`)} }`,
    'request_max_retries = 2',
    'stream_max_retries = 2',
    '',
    '[permissions.swarm-think]',
    'extends = ":read-only"',
    '[permissions.swarm-think.filesystem]',
    'glob_scan_max_depth = 8',
    '":workspace_roots" = "read"',
    deny,
    '',
    '[permissions.swarm-read]',
    'extends = ":read-only"',
    '[permissions.swarm-read.filesystem]',
    'glob_scan_max_depth = 8',
    '":workspace_roots" = "read"',
    deny,
    // no [permissions.swarm-read.network]: the read shell has no network at all
    '',
    '[permissions.swarm-write]',
    'extends = ":workspace"',
    '[permissions.swarm-write.filesystem]',
    'glob_scan_max_depth = 8',
    '":workspace_roots" = "write"',
    deny,
    '[permissions.swarm-write.network]',
    'enabled = true',
    '',
  ];
  return lines.join('\n');
}

export function buildArgs(spec: CodexAgentSpec, schemaPath: string | null): string[] {
  const args = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules',
    '-C', spec.cwd,
    '-m', spec.model,
  ];
  if (schemaPath) args.push('--output-schema', schemaPath);
  args.push('-'); // prompt on stdin
  return args;
}

function roBindTry(p: string): string[] {
  return ['--ro-bind-try', p, p];
}

/**
 * Directories a binary needs mounted to run: the directory it was named by
 * (a symlink, for an npm-installed CLI), the one its real file lives in, and
 * — when the real file sits under a `node_modules` tree — that whole tree, so
 * `require.resolve` finds the package's siblings (the `@openai/codex` wrapper
 * loads its platform package `@openai/codex-linux-x64` that way). Anything
 * under /usr is already mounted.
 */
export function binMounts(bins: string[]): string[] {
  const dirs = new Set<string>();
  for (const b of bins) {
    if (!isAbsolute(b)) continue; // a bare name would mount `.` over the sandbox root; config resolves it first
    dirs.add(dirname(b));
    let real: string;
    try { real = realpathSync(b); } catch { continue; } // resolved by PATH inside
    dirs.add(dirname(real));
    const nm = real.indexOf('/node_modules/');
    if (nm > 0) dirs.add(real.slice(0, nm + '/node_modules'.length));
  }
  const out: string[] = [];
  for (const d of dirs) {
    if (d.startsWith('/usr/') || d === '/usr') continue;
    if ([...dirs].some((o) => o !== d && d.startsWith(o + '/'))) continue; // already inside another mount
    out.push(d);
  }
  return out;
}

/** The outer bubblewrap allow-list. */
export function bwrapArgs(spec: CodexAgentSpec, env: Record<string, string>): string[] {
  const args = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr'];
  for (const d of ['/lib', '/lib64', '/bin', '/sbin']) {
    let st; try { st = lstatSync(d); } catch { continue; }
    if (st.isSymbolicLink()) args.push('--symlink', `usr${d}`, d);
    else if (st.isDirectory()) args.push('--ro-bind', d, d);
  }
  for (const f of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/localtime', '/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/alternatives', '/etc/gai.conf', '/etc/protocols', '/etc/services']) {
    args.push(...roBindTry(f));
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const d of binMounts([spec.codexBin, process.execPath])) args.push(...roBindTry(d));
  for (const p of spec.extraRoBinds) args.push(...roBindTry(p));
  args.push('--bind', spec.homeDir, spec.homeDir);
  args.push(spec.profile === 'write' ? '--bind' : '--ro-bind', spec.cwd, spec.cwd);
  args.push('--chdir', spec.cwd, '--clearenv');
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
  args.push('--', spec.codexBin);
  return args;
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

/** Codex `usage` → the Anthropic-shaped record estimateCost prices. */
function priceable(u: Usage): Record<string, number> {
  return { input_tokens: Math.max(0, u.inputTokens - u.cachedInputTokens), cache_read_input_tokens: u.cachedInputTokens, output_tokens: u.outputTokens };
}

export function runCodexAgent(spec: CodexAgentSpec, meter: UsageMeter, signal: AbortSignal, onActivity: (a: Activity) => void): Promise<CodexOutcome> {
  const started = Date.now();
  mkdirSync(join(spec.homeDir, 'tmp'), { recursive: true, mode: 0o700 });
  const schemaPath = spec.schema ? join(spec.homeDir, 'schema.json') : null;
  if (schemaPath) writeFileSync(schemaPath, JSON.stringify(strictSchema(spec.schema)));

  // Usage accounting lives in the meter callback: it sees every response,
  // including the ones of an agent killed mid-turn.
  let tokens = 0;
  let costUsd = 0;
  let unpriced = false;
  let model: string | null = null;
  let endReason: string | null = null;
  let endDetail = '';
  const lastUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let stop: (why: string, detail: string) => void = () => { /* bound below */ };

  const slot = meter.register({
    upstream: spec.baseUrl,
    bearer: spec.apiKey,
    headers: {
      'x-gate-origin': 'swarmbase',
      'x-gate-channel': headerSafe(spec.runId),
      'x-gate-counterparty': headerSafe(`${spec.n}:${spec.label}`),
      'x-gate-tags': 'swarmbase',
    },
    onUsage: (u) => {
      model = u.model ?? model;
      tokens += u.inputTokens + u.outputTokens;
      lastUsage.inputTokens += u.inputTokens; lastUsage.cachedInputTokens += u.cachedInputTokens; lastUsage.outputTokens += u.outputTokens;
      const m = model ?? spec.model;
      if (priceFor(m)) costUsd += estimateCost(m, priceable(u)); else unpriced = true;
      if (tokens > spec.maxTokens) stop('token-ceiling', `token ceiling: ${tokens} tokens > maxTokens ${spec.maxTokens}`);
      else if (spec.maxBudgetUsd !== null && costUsd > spec.maxBudgetUsd) stop('max_budget', `max_budget: $${costUsd.toFixed(3)} > cap $${spec.maxBudgetUsd.toFixed(2)}`);
    },
  });

  writeFileSync(join(spec.homeDir, 'config.toml'), renderConfig(spec, slot), { mode: 0o600 });

  // The daemon's own node goes first on PATH: an npm-installed codex is a
  // `#!/usr/bin/env node` script, and inside the sandbox only what we mount exists.
  const nodeDir = dirname(process.execPath);
  const basePath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const env: Record<string, string> = {
    PATH: basePath.split(':').includes(nodeDir) ? basePath : `${nodeDir}:${basePath}`,
    HOME: spec.homeDir,
    CODEX_HOME: spec.homeDir,
    TMPDIR: join(spec.homeDir, 'tmp'),
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
  };
  const codexArgs = buildArgs(spec, schemaPath);
  const [cmd, args] = spec.sandbox === 'bwrap'
    ? ['bwrap', [...bwrapArgs(spec, env), ...codexArgs]]
    : [spec.codexBin, codexArgs];

  const out = createWriteStream(spec.streamPath, { flags: 'a' });
  const child = spawn(cmd, args, {
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // own process group, so the CLI's commands die with it
  });
  if (child.pid !== undefined) trackAgentGroup(child.pid);

  let lastText = '';
  let failure: string | null = null;
  let turnUsage: unknown = null;
  let stderrTail = '';

  const killGroup = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, sig); } catch { /* already gone */ }
  };
  stop = (why, detail) => {
    if (endReason) return;
    endReason = why;
    endDetail = detail;
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
  };
  const onAbort = () => stop('cancelled', '');
  if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('timeout', ''), spec.timeoutMs);

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
      if (e.type === 'turn.completed') turnUsage = e.usage ?? null;
      else if (e.type === 'turn.failed') failure = String(e.error?.message ?? 'turn failed');
      else if (e.type === 'error') failure = String(e.message ?? 'error');
      else if (typeof e.type === 'string' && e.type.startsWith('item.') && e.item) {
        const it = e.item as Record<string, any>;
        const done = e.type === 'item.completed';
        switch (it.type) {
          case 'agent_message':
            if (done && typeof it.text === 'string') { lastText = it.text; onActivity({ kind: 'text', summary: clip(it.text, 160) }); }
            break;
          case 'reasoning':
            if (done) onActivity({ kind: 'thinking', summary: '…' });
            break;
          case 'command_execution':
            if (e.type === 'item.started') onActivity({ kind: 'tool_use', summary: clip(`shell ${it.command ?? ''}`, 160) });
            else if (done) onActivity({ kind: 'tool_result', summary: clip(`${it.exit_code ? 'ERROR ' : ''}${it.aggregated_output ?? ''}`, 160) });
            break;
          case 'file_change':
            if (done) onActivity({ kind: 'tool_use', summary: clip(`edit ${JSON.stringify(it.changes ?? [])}`, 160) });
            break;
          case 'mcp_tool_call':
          case 'web_search':
            if (done) onActivity({ kind: 'tool_use', summary: clip(`${it.type} ${it.query ?? it.tool ?? ''}`, 160) });
            break;
          case 'error':
            // advisory (e.g. "model metadata not found"); the exit code decides
            stderrTail = (stderrTail + '\n' + String(it.message ?? '')).slice(-4000);
            break;
        }
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });

  return new Promise<CodexOutcome>((resolve) => {
    let settled = false;
    const finish = (code: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (child.pid !== undefined) untrackAgentGroup(child.pid);
      meter.release(slot.bearer);
      out.end();
      try { rmSync(spec.homeDir, { recursive: true, force: true }); } catch { /* best effort */ }
      const durationMs = Date.now() - started;
      // The meter saw nothing (a body it could not parse) but the CLI counted
      // its turn: take the CLI's word rather than report a free agent.
      const t = turnUsage as Record<string, unknown> | null;
      if (tokens === 0 && t && (Number(t.input_tokens) > 0 || Number(t.output_tokens) > 0)) {
        const u: Usage = { inputTokens: Number(t.input_tokens ?? 0), cachedInputTokens: Number(t.cached_input_tokens ?? 0), outputTokens: Number(t.output_tokens ?? 0), model: null };
        tokens = u.inputTokens + u.outputTokens;
        lastUsage.inputTokens = u.inputTokens; lastUsage.cachedInputTokens = u.cachedInputTokens; lastUsage.outputTokens = u.outputTokens;
        if (priceFor(spec.model)) costUsd = estimateCost(spec.model, priceable(u)); else unpriced = true;
      }
      const usage = { ...lastUsage, tokens, turn: turnUsage };
      const base = { costUsd, durationMs, usage, unpriced, tokens };
      const fail = (error: string, reason: string) => resolve({ ok: false, result: null, error, reason, ...base });

      if (endReason === 'cancelled' || endReason === 'timeout') { fail(endReason, endReason); return; }
      if (endReason) { fail(endDetail, endReason); return; }
      if (spawnError) { fail(`spawn failed: ${spawnError.message}`, 'exit'); return; }
      if (failure) { fail(`api_error: ${clip(failure, 300)}`, 'result-error'); return; }
      if (code !== 0) { fail(`exit ${code}; ${clip(stderrTail.replace(/WARNING: proceeding, even though we could not create PATH aliases[^\n]*/g, ''), 400)}`, 'exit'); return; }
      if (spec.schema) {
        let parsed: unknown = null;
        try { parsed = JSON.parse(lastText); } catch { /* not JSON */ }
        if (parsed === null || typeof parsed !== 'object') { fail('no structured output produced', 'result-error'); return; }
        resolve({ ok: true, result: parsed, error: null, reason: null, ...base });
        return;
      }
      resolve({ ok: true, result: lastText, error: null, reason: null, ...base });
    };
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
  });
}

/** Header values: printable ASCII only. */
function headerSafe(v: string): string {
  return v.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
}

/** Boot-time: a recorded process group whose leader is a SwarmBase-launched
 *  codex (or its bubblewrap wrapper). */
export function looksLikeCodexAgent(cmd: string): boolean {
  return /\bcodex\b/.test(cmd) && /\bexec\b/.test(cmd) && cmd.includes('--json') && cmd.includes('--ephemeral');
}

export function bwrapAvailable(): boolean {
  for (const d of (process.env.PATH ?? '').split(':')) if (d && existsSync(join(d, 'bwrap'))) return true;
  return false;
}
