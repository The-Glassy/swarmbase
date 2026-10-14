/**
 * SwarmBase configuration — one JSON file (default ~/.swarmbase/config.json,
 * override with SWARMBASE_CONFIG). Secrets never live in it: callers are
 * identified by the sha256 of their MCPL token, and each caller's gate token
 * is read from its own 0600 file at agent launch.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

export type Profile = 'think' | 'read' | 'write';
export const PROFILES: readonly Profile[] = ['think', 'read', 'write'];
export type EngineName = 'claude' | 'codex';
export const ENGINES: readonly EngineName[] = ['claude', 'codex'];

export interface ClaudeEngineConfig {
  /** The Claude Code CLI. */
  bin: string;
  /** ANTHROPIC_BASE_URL for agents, e.g. `https://<gateway>/anthropic`. null = the vendor API. */
  baseUrl: string | null;
}

export interface CodexEngineConfig {
  /** The Codex CLI. A bare name is resolved on PATH at config load (and the
   *  daemon refuses to start when it isn't there), so the sandbox always
   *  mounts a real path. */
  bin: string;
  /** Responses-API endpoint the agents run against, e.g. `https://<gateway>/codex`.
   *  null = the engine is not offered (there is no vendor default: the CLI's own
   *  login mode would use the operator's ChatGPT account). */
  baseUrl: string | null;
  /** OS-level confinement around the CLI: `bwrap` (an allow-list of mounts; the
   *  default, and startup fails when bubblewrap is missing) or `none` (the CLI's
   *  own deny-list only; codex shells are then offered to `write`-trusted callers only). */
  sandbox: 'bwrap' | 'none';
  /** Default per-agent token ceiling (input + output over the agent's requests). */
  maxTokensDefault: number;
  /** Largest per-agent ceiling a script may ask for; `opts.maxTokens` is clamped to it. */
  maxTokensMax: number;
  /** Extra read-only paths mounted into the wrapper (a CA bundle, a toolchain). */
  extraRoBinds: string[];
}

export interface CallerPolicy {
  /** Stable identity (resident name). Runs are owned by it. */
  name: string;
  /** sha256 hex of the caller's MCPL WebSocket token. */
  tokenSha256: string;
  /** File holding the API key (or inference-gateway token) this caller's agents run on. */
  apiKeyFile: string;
  engines: EngineName[];
  /** Highest tool profile this caller's subagents may run with. */
  maxProfile: Profile;
  /** Absolute directories a subagent `cwd` may sit under. Default cwd = the run's own work dir. */
  cwdRoots: string[];
  /** Default model per engine when neither the run nor the agent() call names one. */
  defaultModels: Record<EngineName, string>;
  /** @deprecated alias of defaultModels.claude */
  defaultModel: string;
  /** Default per-run USD ceiling when `run` doesn't name one. */
  runUsdDefault: number;
  /** Largest per-run ceiling the caller may request. */
  runUsdMax: number;
  /** Default per-run token budget for codex agents (whose spend is $0 without a
   *  price row, so the USD ceiling alone does not bound them). */
  runTokensDefault: number;
  /** Largest per-run token budget the caller may request. */
  runTokensMax: number;
  maxActiveRuns: number;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Where the config was read from (denied to subagents). */
  configPath: string | null;
  /** Public (tailnet) base URL of the dashboard, used in links handed to callers. */
  publicUrl: string | null;
  maxConcurrentAgents: number;
  perRunConcurrency: number;
  maxAgentsPerRun: number;
  agentTimeoutMs: number;
  runTimeoutMs: number;
  /** Chars of the return value inlined into the completion push. */
  previewChars: number;
  engines: { claude: ClaudeEngineConfig; codex: CodexEngineConfig };
  /** @deprecated use engines.claude.baseUrl */
  apiBaseUrl?: string | null;
  /** @deprecated use engines.claude.bin */
  claudeBin?: string;
  /** Delete each run's `work/` (clones, toolchains, scratch) when the run ends, unless the run
   *  was started with `keepWork`. Also sweeps the work dirs of ended runs on boot. Default true. */
  deleteWorkOnEnd: boolean;
  /** Extra/override model price rows (USD per MTok) for estimating killed agents' spend
   *  (and all of a codex agent's spend: the Codex CLI reports tokens, not cost). */
  prices?: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }>;
  dashboard: {
    /** Tailscale logins (Tailscale-User-Login header) allowed to cancel/skip. */
    adminLogins: string[];
  };
  callers: CallerPolicy[];
}

export const DEFAULT_MODELS: Record<EngineName, string> = { claude: 'claude-sonnet-5-5', codex: 'gpt-6-astra' };

const DEFAULTS: Omit<Config, 'callers'> = {
  host: '127.0.0.1',
  port: 7360,
  dataDir: join(homedir(), '.swarmbase'),
  configPath: null,
  publicUrl: null,
  maxConcurrentAgents: 10,
  perRunConcurrency: 8,
  maxAgentsPerRun: 200,
  agentTimeoutMs: 30 * 60_000,
  runTimeoutMs: 6 * 60 * 60_000,
  previewChars: 4000,
  engines: {
    claude: { bin: 'claude', baseUrl: null },
    codex: { bin: 'codex', baseUrl: null, sandbox: 'bwrap', maxTokensDefault: 3_000_000, maxTokensMax: 3_000_000, extraRoBinds: [] },
  },
  deleteWorkOnEnd: true,
  dashboard: { adminLogins: [] },
};

function expand(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export function loadConfig(path = process.env.SWARMBASE_CONFIG ?? join(homedir(), '.swarmbase', 'config.json')): Config {
  const cfg = parseConfig(JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>);
  cfg.configPath = resolve(path);
  return cfg;
}

/** A bare command name → its path on PATH (the first regular, executable file). */
export function resolveOnPath(name: string, pathEnv = process.env.PATH ?? ''): string | null {
  if (name.includes('/')) return resolve(expand(name));
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isFile() && (st.mode & 0o111)) return p;
  }
  return null;
}

export function parseConfig(raw: Partial<Config>, pathEnv = process.env.PATH ?? ''): Config {
  const rawEngines = (raw.engines ?? {}) as Partial<Config['engines']>;
  const claude: ClaudeEngineConfig = {
    ...DEFAULTS.engines.claude,
    ...(raw.claudeBin !== undefined ? { bin: raw.claudeBin } : {}),
    ...(raw.apiBaseUrl !== undefined ? { baseUrl: raw.apiBaseUrl } : {}),
    ...(rawEngines.claude ?? {}),
  };
  const rawCodex = (rawEngines.codex ?? {}) as Partial<CodexEngineConfig>;
  const codex: CodexEngineConfig = {
    ...DEFAULTS.engines.codex,
    ...rawCodex,
    // the cap follows a raised default unless set explicitly
    maxTokensMax: rawCodex.maxTokensMax ?? Math.max(DEFAULTS.engines.codex.maxTokensMax, Number(rawCodex.maxTokensDefault ?? 0)),
  };
  if (codex.sandbox !== 'bwrap' && codex.sandbox !== 'none') throw new Error(`config: engines.codex.sandbox must be "bwrap" or "none"`);
  if (!(Number(codex.maxTokensDefault) > 0)) throw new Error('config: engines.codex.maxTokensDefault must be a positive number');
  if (!(Number(codex.maxTokensMax) >= codex.maxTokensDefault)) throw new Error('config: engines.codex.maxTokensMax must be at least maxTokensDefault');
  codex.extraRoBinds = (codex.extraRoBinds ?? []).map((p) => resolve(expand(String(p))));
  if (codex.baseUrl) {
    const bin = resolveOnPath(String(codex.bin), pathEnv);
    if (!bin || !isAbsolute(bin)) throw new Error(`config: engines.codex.bin ${JSON.stringify(codex.bin)} was not found on PATH; give its absolute path`);
    codex.bin = bin;
  }
  const cfg: Config = {
    ...DEFAULTS,
    ...raw,
    engines: { claude, codex },
    dashboard: { ...DEFAULTS.dashboard, ...(raw.dashboard ?? {}) },
    callers: (raw.callers ?? []).map(validateCaller),
  };
  cfg.apiBaseUrl = claude.baseUrl;
  cfg.claudeBin = claude.bin;
  cfg.dataDir = expand(cfg.dataDir);
  const names = new Set<string>();
  for (const c of cfg.callers) {
    if (names.has(c.name)) throw new Error(`config: duplicate caller "${c.name}"`);
    names.add(c.name);
    if (c.engines.includes('codex') && !codex.baseUrl) {
      throw new Error(`config: caller ${c.name} lists the codex engine but engines.codex.baseUrl is not set`);
    }
  }
  return cfg;
}

function validateCaller(c: Partial<CallerPolicy>): CallerPolicy {
  if (!c.name || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(c.name)) throw new Error(`config: bad caller name ${JSON.stringify(c.name)}`);
  if (!c.tokenSha256 || !/^[0-9a-f]{64}$/.test(c.tokenSha256)) throw new Error(`config: caller ${c.name} needs tokenSha256 (64 hex)`);
  if (!c.apiKeyFile) throw new Error(`config: caller ${c.name} needs apiKeyFile`);
  const maxProfile = c.maxProfile ?? 'read';
  if (!PROFILES.includes(maxProfile)) throw new Error(`config: caller ${c.name} bad maxProfile ${maxProfile}`);
  const engines = c.engines ?? ['claude'];
  for (const e of engines) if (!ENGINES.includes(e)) throw new Error(`config: caller ${c.name} unknown engine ${JSON.stringify(e)} (${ENGINES.join(' | ')})`);
  if (!engines.length) throw new Error(`config: caller ${c.name} lists no engines`);
  const defaultModels: Record<EngineName, string> = {
    ...DEFAULT_MODELS,
    ...(c.defaultModel ? { claude: c.defaultModel } : {}),
    ...(c.defaultModels ?? {}),
  };
  return {
    name: c.name,
    tokenSha256: c.tokenSha256,
    apiKeyFile: expand(c.apiKeyFile),
    engines,
    maxProfile,
    cwdRoots: (c.cwdRoots ?? []).map((r) => resolve(expand(r))),
    defaultModels,
    defaultModel: defaultModels.claude,
    runUsdDefault: positive('runUsdDefault', c.runUsdDefault ?? 5),
    runUsdMax: positive('runUsdMax', c.runUsdMax ?? 25),
    runTokensDefault: positive('runTokensDefault', c.runTokensDefault ?? 10_000_000),
    runTokensMax: positive('runTokensMax', c.runTokensMax ?? 30_000_000),
    maxActiveRuns: c.maxActiveRuns ?? 3,
  };
  function positive(key: string, v: number): number {
    if (!(Number(v) > 0)) throw new Error(`config: caller ${c.name} ${key} must be a positive number`);
    return Number(v);
  }
}

export function profileRank(p: Profile): number {
  return PROFILES.indexOf(p);
}

/** True when `dir` (after symlink resolution) is `root` or inside it. */
export function isUnder(dir: string, root: string): boolean {
  let real: string;
  let realRoot: string;
  try { real = realpathSync(dir); realRoot = realpathSync(root); } catch { return false; }
  return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}
