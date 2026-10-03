/**
 * SwarmBase configuration — one JSON file (default ~/.swarmbase/config.json,
 * override with SWARMBASE_CONFIG). Secrets never live in it: callers are
 * identified by the sha256 of their MCPL token, and each caller's gate token
 * is read from its own 0600 file at agent launch.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export type Profile = 'think' | 'read' | 'write';
export const PROFILES: readonly Profile[] = ['think', 'read', 'write'];
export type EngineName = 'claude';
export const ENGINES: readonly EngineName[] = ['claude'];

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
  defaultModel: string;
  /** Default per-run USD ceiling when `run` doesn't name one. */
  runUsdDefault: number;
  /** Largest per-run ceiling the caller may request. */
  runUsdMax: number;
  maxActiveRuns: number;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Public (tailnet) base URL of the dashboard, used in links handed to callers. */
  publicUrl: string | null;
  maxConcurrentAgents: number;
  perRunConcurrency: number;
  maxAgentsPerRun: number;
  agentTimeoutMs: number;
  runTimeoutMs: number;
  /** Chars of the return value inlined into the completion push. */
  previewChars: number;
  /** ANTHROPIC_BASE_URL for agents, e.g. an inference gateway. null = the vendor API. */
  apiBaseUrl: string | null;
  claudeBin: string;
  /** Extra/override model price rows (USD per MTok) for estimating killed agents' spend. */
  prices?: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }>;
  dashboard: {
    /** Tailscale logins (Tailscale-User-Login header) allowed to cancel/skip. */
    adminLogins: string[];
  };
  callers: CallerPolicy[];
}

const DEFAULTS: Omit<Config, 'callers'> = {
  host: '127.0.0.1',
  port: 7360,
  dataDir: join(homedir(), '.swarmbase'),
  publicUrl: null,
  maxConcurrentAgents: 10,
  perRunConcurrency: 8,
  maxAgentsPerRun: 200,
  agentTimeoutMs: 30 * 60_000,
  runTimeoutMs: 6 * 60 * 60_000,
  previewChars: 4000,
  apiBaseUrl: null,
  claudeBin: 'claude',
  dashboard: { adminLogins: [] },
};

function expand(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export function loadConfig(path = process.env.SWARMBASE_CONFIG ?? join(homedir(), '.swarmbase', 'config.json')): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  const cfg: Config = {
    ...DEFAULTS,
    ...raw,
    dashboard: { ...DEFAULTS.dashboard, ...(raw.dashboard ?? {}) },
    callers: (raw.callers ?? []).map(validateCaller),
  };
  cfg.dataDir = expand(cfg.dataDir);
  const names = new Set<string>();
  for (const c of cfg.callers) {
    if (names.has(c.name)) throw new Error(`config: duplicate caller "${c.name}"`);
    names.add(c.name);
  }
  return cfg;
}

function validateCaller(c: Partial<CallerPolicy>): CallerPolicy {
  if (!c.name || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(c.name)) throw new Error(`config: bad caller name ${JSON.stringify(c.name)}`);
  if (!c.tokenSha256 || !/^[0-9a-f]{64}$/.test(c.tokenSha256)) throw new Error(`config: caller ${c.name} needs tokenSha256 (64 hex)`);
  if (!c.apiKeyFile) throw new Error(`config: caller ${c.name} needs apiKeyFile`);
  const maxProfile = c.maxProfile ?? 'read';
  if (!PROFILES.includes(maxProfile)) throw new Error(`config: caller ${c.name} bad maxProfile ${maxProfile}`);
  const engines = (c.engines ?? ['claude']).filter((e): e is EngineName => ENGINES.includes(e as EngineName));
  return {
    name: c.name,
    tokenSha256: c.tokenSha256,
    apiKeyFile: expand(c.apiKeyFile),
    engines,
    maxProfile,
    cwdRoots: (c.cwdRoots ?? []).map((r) => resolve(expand(r))),
    defaultModel: c.defaultModel ?? 'claude-sonnet-5-5',
    runUsdDefault: c.runUsdDefault ?? 5,
    runUsdMax: c.runUsdMax ?? 25,
    maxActiveRuns: c.maxActiveRuns ?? 3,
  };
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
