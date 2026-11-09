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

/** Extra MCP servers for a caller's claude agents (e.g. a browser bridge). The
 *  config file may hold a secret: it is denied to every agent by path. */
export interface AgentMcp {
  /** claude --mcp-config file, used instead of the empty one. */
  configPath: string;
  /** Tool names (mcp__<server>__<tool>) added to --tools and --allowedTools. */
  allowedTools: string[];
  /** Profiles that get them (default read and write); never think. */
  profiles: Profile[];
}

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
   *  Optional for callers with codexAuthFile (the default ChatGPT backend). */
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
  /** File holding the API key (or inference-gateway token) this caller's agents run on.
   *  Gateway-mode Codex needs it; ChatGPT-mode Codex uses codexAuthFile. */
  apiKeyFile: string | null;
  /** File holding a Claude subscription token (`claude setup-token`), for the claude
   *  engine. Passed as CLAUDE_CODE_OAUTH_TOKEN and, when set, used instead of apiKeyFile,
   *  so a request never carries both schemes (connectome-host's ANTHROPIC_AUTH_TOKEN). */
  authTokenFile: string | null;
  /** Optional Linux identity. Omit to retain the original daemon-user behavior. */
  runAs?: string;
  /** Per-caller workspace root; defaults to the Linux account's home. */
  homeDir?: string;
  /** Explicit tenant workspace group; permits foreign-owned setgid cwdRoots. */
  cwdGid?: number;
  maxConcurrentAgents?: number;
  perRunConcurrency?: number;
  /** Absolute path to a ChatGPT-login auth.json; overrides Codex gateway mode. */
  codexAuthFile?: string | null;
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
  /** null: agents get no MCP servers. */
  agentMcp: AgentMcp | null;
}

export interface DashboardAccess {
  /** Tailscale logins (Tailscale-User-Login header) allowed to view runs, prompts and transcripts.
   *  Admins can always view. Everyone else, including requests with no identity, is refused. */
  viewerLogins: string[];
  /** Tailscale logins allowed to view AND cancel/skip. */
  adminLogins: string[];
}

export interface Config {
  /** Root-owned supervisor, executed by sudo as the caller (never as root). */
  userHelper: string;
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
  /** Wall clock for one agent, and the most a script may ask for. null = none; the run's deadline still ends it. */
  agentTimeoutMs: number | null;
  /** How long a run has before it fails, unless its caller pushes the deadline back with `extend`. */
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
  dashboard: DashboardAccess;
  /** Private Unix listener; when set, TCP never serves dashboard routes. */
  dashboardSocket?: string;
  callers: CallerPolicy[];
}

export const DEFAULT_MODELS: Record<EngineName, string> = { claude: 'claude-sonnet-5-5', codex: 'gpt-6-astra' };

const DEFAULTS: Omit<Config, 'callers'> = {
  userHelper: '/usr/local/libexec/swarmbase-user',
  host: '127.0.0.1',
  port: 7360,
  dataDir: join(homedir(), '.swarmbase'),
  configPath: null,
  publicUrl: null,
  maxConcurrentAgents: 10,
  perRunConcurrency: 8,
  maxAgentsPerRun: 200,
  agentTimeoutMs: null,
  runTimeoutMs: 24 * 60 * 60_000,
  previewChars: 4000,
  engines: {
    claude: { bin: 'claude', baseUrl: null },
    codex: { bin: 'codex', baseUrl: null, sandbox: 'bwrap', maxTokensDefault: 3_000_000, maxTokensMax: 3_000_000, extraRoBinds: [] },
  },
  deleteWorkOnEnd: true,
  dashboard: { viewerLogins: [], adminLogins: [] },
};

export const DEFAULT_CONFIG_PATH = join(homedir(), '.swarmbase', 'config.json');

function loginList(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim())) {
    throw new Error(`config: dashboard.${field} must be an array of logins`);
  }
  return v.map((x: string) => x.trim().toLowerCase());
}

function parseDashboard(raw: unknown): DashboardAccess {
  const d = (raw ?? {}) as Record<string, unknown>;
  return { viewerLogins: loginList(d.viewerLogins, 'viewerLogins'), adminLogins: loginList(d.adminLogins, 'adminLogins') };
}

/**
 * Dashboard access lists, re-read from the config file whenever its mtime
 * changes, so adding or removing a viewer needs no restart (a restart kills
 * in-flight agents). A file that fails to parse keeps the last good lists.
 */
export function watchDashboardAccess(path: string, initial: DashboardAccess, log: (line: string) => void): () => DashboardAccess {
  let current = initial;
  // The first request always re-reads: `initial` may predate an edit made during boot.
  let mtimeMs = -1;
  return () => {
    let m: number;
    try { m = statSync(path).mtimeMs; } catch { return current; }
    if (m === mtimeMs) return current;
    mtimeMs = m;
    try {
      current = parseDashboard((JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>).dashboard);
      log(`dashboard access reloaded: ${current.viewerLogins.length} viewer(s), ${current.adminLogins.length} admin(s)`);
    } catch (e) {
      log(`dashboard access reload failed, keeping previous lists: ${(e as Error).message}`);
    }
    return current;
  };
}

function expand(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export function loadConfig(path = process.env.SWARMBASE_CONFIG ?? DEFAULT_CONFIG_PATH): Config {
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
  if (raw.dashboardSocket !== undefined && (typeof raw.dashboardSocket !== 'string' || !isAbsolute(raw.dashboardSocket))) throw new Error('config: dashboardSocket must be an absolute Unix socket path');
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
  if (codex.baseUrl || raw.callers?.some((c) => c.engines?.includes('codex') && c.codexAuthFile)) {
    const bin = resolveOnPath(String(codex.bin), pathEnv);
    if (!bin || !isAbsolute(bin)) throw new Error(`config: engines.codex.bin ${JSON.stringify(codex.bin)} was not found on PATH; give its absolute path`);
    codex.bin = bin;
  }
  const cfg: Config = {
    ...DEFAULTS,
    ...raw,
    engines: { claude, codex },
    dashboard: parseDashboard(raw.dashboard),
    callers: (raw.callers ?? []).map(validateCaller),
  };
  cfg.apiBaseUrl = claude.baseUrl;
  cfg.claudeBin = claude.bin;
  cfg.dataDir = expand(cfg.dataDir);
  if (typeof cfg.userHelper !== 'string' || !isAbsolute(cfg.userHelper)) throw new Error('config: userHelper must be an absolute path');
  if (typeof cfg.deleteWorkOnEnd !== 'boolean') throw new Error('config: deleteWorkOnEnd must be true or false');
  const usableMs = (v: unknown): boolean => typeof v === 'number' && v > 0 && Number.isFinite(new Date(Date.now() + v).getTime());
  if (cfg.agentTimeoutMs !== null && !usableMs(cfg.agentTimeoutMs)) throw new Error('config: agentTimeoutMs must be a positive number of milliseconds, or null for none');
  if (!usableMs(cfg.runTimeoutMs)) throw new Error('config: runTimeoutMs must be a positive number of milliseconds');
  const names = new Set<string>();
  for (const c of cfg.callers) {
    if (names.has(c.name)) throw new Error(`config: duplicate caller "${c.name}"`);
    names.add(c.name);
    if (c.engines.includes('codex') && !c.codexAuthFile && !codex.baseUrl) {
      throw new Error(`config: caller ${c.name} lists the codex engine but engines.codex.baseUrl is not set`);
    }
  }
  return cfg;
}

function validateCaller(c: Partial<CallerPolicy>): CallerPolicy {
  if (!c.name || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(c.name)) throw new Error(`config: bad caller name ${JSON.stringify(c.name)}`);
  if (!c.tokenSha256 || !/^[0-9a-f]{64}$/.test(c.tokenSha256)) throw new Error(`config: caller ${c.name} needs tokenSha256 (64 hex)`);
  if (c.runAs !== undefined && (typeof c.runAs !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(c.runAs) || c.runAs === 'root')) {
    throw new Error(`config: caller ${c.name} runAs must be a non-root Linux username`);
  }
  if (c.homeDir !== undefined && (!c.runAs || typeof c.homeDir !== 'string' || !isAbsolute(c.homeDir))) {
    throw new Error(`config: caller ${c.name} homeDir requires runAs and an absolute path`);
  }
  if (c.cwdGid !== undefined && (!c.runAs || !Number.isInteger(c.cwdGid) || c.cwdGid <= 0)) throw new Error(`config: caller ${c.name} cwdGid needs runAs and a positive gid`);
  for (const field of ['maxConcurrentAgents', 'perRunConcurrency'] as const) {
    if (c[field] !== undefined && (!Number.isInteger(c[field]) || c[field]! <= 0)) throw new Error(`config: caller ${c.name} ${field} must be a positive integer`);
  }
  const maxProfile = c.maxProfile ?? 'read';
  if (!PROFILES.includes(maxProfile)) throw new Error(`config: caller ${c.name} bad maxProfile ${maxProfile}`);
  const engines = c.engines ?? ['claude'];
  for (const e of engines) if (!ENGINES.includes(e)) throw new Error(`config: caller ${c.name} unknown engine ${JSON.stringify(e)} (${ENGINES.join(' | ')})`);
  if (!engines.length) throw new Error(`config: caller ${c.name} lists no engines`);
  if (engines.includes('claude') && !c.apiKeyFile && !c.authTokenFile) throw new Error(`config: caller ${c.name} needs apiKeyFile or authTokenFile for claude`);
  if (c.codexAuthFile != null && (typeof c.codexAuthFile !== 'string' || !isAbsolute(c.codexAuthFile) || GLOB_CHARS_RE.test(c.codexAuthFile))) {
    throw new Error(`config: caller ${c.name} codexAuthFile must be an absolute path without glob characters`);
  }
  if (engines.includes('codex') && !c.codexAuthFile && !c.apiKeyFile) {
    throw new Error(`config: caller ${c.name} lists the codex engine, which needs apiKeyFile + engines.codex.baseUrl or codexAuthFile; authTokenFile is for claude only`);
  }
  const defaultModels: Record<EngineName, string> = {
    ...DEFAULT_MODELS,
    ...(c.defaultModel ? { claude: c.defaultModel } : {}),
    ...(c.defaultModels ?? {}),
  };
  return {
    name: c.name,
    tokenSha256: c.tokenSha256,
    apiKeyFile: c.apiKeyFile ? expand(c.apiKeyFile) : null,
    authTokenFile: c.authTokenFile ? expand(c.authTokenFile) : null,
    ...(c.runAs ? { runAs: c.runAs, ...(c.homeDir ? { homeDir: resolve(c.homeDir) } : {}) } : {}),
    codexAuthFile: c.codexAuthFile ?? null,
    ...(c.cwdGid === undefined ? {} : { cwdGid: c.cwdGid }),
    ...(c.maxConcurrentAgents === undefined ? {} : { maxConcurrentAgents: c.maxConcurrentAgents }),
    ...(c.perRunConcurrency === undefined ? {} : { perRunConcurrency: c.perRunConcurrency }),
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
    agentMcp: c.agentMcp ? validateAgentMcp(c.name, engines, c.agentMcp) : null,
  };
  function positive(key: string, v: number): number {
    if (!(Number(v) > 0)) throw new Error(`config: caller ${c.name} ${key} must be a positive number`);
    return Number(v);
  }
}

const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
/** Pattern characters: the config path becomes a deny rule, which would then match something else. */
const GLOB_CHARS_RE = /[*?[\]{}\\]/;

function validateAgentMcp(caller: string, engines: EngineName[], m: Partial<AgentMcp>): AgentMcp {
  // Mixed-engine callers may use MCP on Claude; Codex never receives this config.
  if (!engines.includes('claude')) throw new Error(`config: caller ${caller} agentMcp needs the claude engine`);
  const configPath = typeof m.configPath === 'string' ? expand(m.configPath) : '';
  if (!isAbsolute(configPath)) throw new Error(`config: caller ${caller} agentMcp.configPath must be an absolute path`);
  let real = configPath;
  try { real = realpathSync(configPath); } catch { /* not there yet */ }
  if (GLOB_CHARS_RE.test(configPath) || GLOB_CHARS_RE.test(real)) {
    throw new Error(`config: caller ${caller} agentMcp.configPath may not contain * ? [ ] { } or \\ (it is denied to agents by a path pattern)`);
  }
  const allowedTools = m.allowedTools;
  if (!Array.isArray(allowedTools) || !allowedTools.length || !allowedTools.every((t) => typeof t === 'string' && MCP_TOOL_RE.test(t))) {
    throw new Error(`config: caller ${caller} agentMcp.allowedTools must list MCP tool names (mcp__<server>__<tool>)`);
  }
  const profiles = m.profiles ?? ['read', 'write'];
  if (!Array.isArray(profiles) || !profiles.length || !profiles.every((p) => p === 'read' || p === 'write')) {
    throw new Error(`config: caller ${caller} agentMcp.profiles may name read and write only`);
  }
  return { configPath: resolve(configPath), allowedTools: [...new Set(allowedTools)], profiles: [...new Set(profiles)] };
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
