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
 *    off); read = shell under `:read-only`, web search; write = shell under
 *    `:workspace`. Sub-agents, goals, image viewing and user-input requests
 *    are off everywhere (the image tool reads files from the CLI process,
 *    outside its sandbox).
 *  - Budget: the CLI reports usage only in `turn.completed`, and an exec run
 *    is one turn, so the meter prices every response as it passes: the agent
 *    is stopped when its token ceiling (opts.maxTokens) or, when a price row
 *    exists for the model, its USD cap is crossed. Overshoot is bounded by one
 *    response. Without a price row the agent costs $0 and the ceiling is the
 *    only limit (the ChatGPT backend is subscription-metered).
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
import { createWriteStream, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Profile } from '../config.js';
import { estimateCost, priceFor, type Activity, type AgentOutcome } from './claude.js';
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
 *  wrapper is the allow-list). Mirrors the claude engine's deny rules. */
export function denyPaths(dataDir: string, homeDir: string): string[] {
  const h = homedir();
  const d = dataDir.replace(/\/+$/, '');
  return [
    `${d}/*.token`, `${d}/*.key`, `${d}/config.json`, `${d}/config.json.*`, `${d}/outbox.json`, `${d}/live-agents.json`,
    ...['meta.json', 'events.jsonl', 'journal.jsonl', 'script.js', 'args.json', 'result.json', 'agents/*.jsonl', 'agents/*.json', 'agents/*.txt', 'agents/*.md'].map((f) => `${d}/runs/*/${f}`),
    `${homeDir}/config.toml`, // the meter bearer; the dir itself stays readable so `bash -l` finds an (absent) rc file quietly
    `${h}/.ssh`, `${h}/.claude`, `${h}/.claude.json`, `${h}/.codex`, `${h}/.aws`, `${h}/.config`, `${h}/.gnupg`,
  ];
}

/** The agent's CODEX_HOME/config.toml. */
export function renderConfig(spec: CodexAgentSpec, meter: { baseUrl: string; bearer: string }): string {
  const deny = denyPaths(spec.dataDir, spec.homeDir).map((p) => `${tomlStr(p)} = "deny"`).join('\n');
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
    '":workspace_roots" = "read"',
    deny,
    '',
    '[permissions.swarm-read]',
    'extends = ":read-only"',
    '[permissions.swarm-read.filesystem]',
    '":workspace_roots" = "read"',
    deny,
    '',
    '[permissions.swarm-write]',
    'extends = ":workspace"',
    '[permissions.swarm-write.filesystem]',
    '":workspace_roots" = "write"',
    deny,
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
  const binDirs = new Set<string>();
  for (const b of [spec.codexBin, process.execPath]) {
    try { binDirs.add(dirname(realpathSync(b))); } catch { /* resolved by PATH inside */ }
  }
  for (const d of binDirs) if (!d.startsWith('/usr/')) args.push(...roBindTry(d));
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
  if (schemaPath) writeFileSync(schemaPath, JSON.stringify(spec.schema));

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
      else if (spec.maxBudgetUsd !== null && !unpriced && costUsd > spec.maxBudgetUsd) stop('max_budget', `max_budget: $${costUsd.toFixed(3)} > cap $${spec.maxBudgetUsd.toFixed(2)}`);
    },
  });

  writeFileSync(join(spec.homeDir, 'config.toml'), renderConfig(spec, slot), { mode: 0o600 });

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
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
    setTimeout(() => killGroup('SIGKILL'), 5000).unref();
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
      meter.release(slot.bearer);
      out.end();
      try { rmSync(spec.homeDir, { recursive: true, force: true }); } catch { /* best effort */ }
      const durationMs = Date.now() - started;
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
