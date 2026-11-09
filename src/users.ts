/** Linux caller isolation. sudo only runs the unprivileged, root-owned helper;
 * no operation in a caller-controlled tree is performed with daemon authority. */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Config } from './config.js';

export interface CallerUser { user: string; root: string; helper: string; cwdRoots?: string[] }
export interface UserFiles { home: string; files: Record<string, string> }
export const HELPER_ENV = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
/** Replaced by the helper with a validated directory fd, consumed by bwrap. */
export const PINNED_CWD = '__SWARMBASE_PINNED_CWD__';

export function helperCommand(user: CallerUser): { command: string; args: string[] } {
  return { command: '/usr/bin/sudo', args: ['-n', '-u', user.user, '--', user.helper] };
}

export interface AgentLaunch {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  input: string; keepOpen: boolean;
}

/** Pure argument builder; tests can inspect the privilege boundary without sudo. */
export function buildAgentLaunch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  prompt: string, user?: CallerUser, files?: UserFiles): AgentLaunch {
  if (!user) return { command, args, cwd, env, input: prompt, keepOpen: false };
  return { ...helperCommand(user), cwd: '/', env: HELPER_ENV, keepOpen: true,
    input: JSON.stringify({ op: 'launch', command, args, cwd, env, prompt, files, roots: [user.root, ...(user.cwdRoots ?? [])] }) + '\n' };
}

export function assertNoCallerAccess(user: CallerUser, entries: { path: string; read: boolean; write: boolean; execute: boolean; directory: boolean }[]): void {
  for (const entry of entries) {
    if (entry.read || entry.write || entry.execute) {
      throw new Error(`runAs: ${user.user} can access '${entry.path}'; remove shared groups/ACLs (setfacl -b '${entry.path}'), then chmod ${entry.directory ? '0700' : '0600'} '${entry.path}' or use a private caller group with mode 0750; restart the daemon`);
    }
  }
}

export function protectedParents(paths: string[]): string[] {
  const parents = new Set<string>();
  for (const configured of paths) {
    const path = resolve(configured);
    const targets = [path];
    try { targets.push(realpathSync(path)); } catch { /* absent path: still check existing ancestors below */ }
    for (const target of targets) {
      for (let p = dirname(target); ; p = dirname(p)) {
        parents.add(p);
        try {
          const real = realpathSync(p);
          if (real !== p) {
            for (let r = real; ; r = dirname(r)) {
              parents.add(r);
              if (dirname(r) === r) break;
            }
          }
        } catch { /* inaccessible/missing parents are also probed under the caller */ }
        if (dirname(p) === p) break;
      }
    }
  }
  return [...parents];
}

export function userOperation(user: CallerUser, request: object): any {
  const { command, args } = helperCommand(user);
  try {
    return JSON.parse(execFileSync(command, args, {
      input: JSON.stringify(request) + '\n', encoding: 'utf8', env: HELPER_ENV, cwd: '/', timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch (e) {
    const stderr = String((e as { stderr?: string }).stderr ?? '').trim();
    throw new Error(`caller user ${user.user}: ${stderr || (e as Error).message}. Install dependencies (apt-get install sudo python3), ensure the account exists (useradd --create-home --user-group ${user.user}), install ${user.helper} root:root 0755 and allow: ${process.env.USER ?? '<daemon>'} ALL=(${user.user}) NOPASSWD: ${user.helper}`);
  }
}

/** Check the actual access decision under each uid, including supplementary
 * groups and ACLs, rather than guessing from the world permission bits. */
export function initializeCallerUsers(cfg: Config, operation = userOperation): Map<string, CallerUser> {
  const isolated = cfg.callers.filter((c) => c.runAs);
  const users = new Map<string, CallerUser>();
  if (!isolated.length) return users;
  // Helper probes run from /, while legacy paths are relative to daemon cwd.
  // Normalize before crossing that boundary so probes check the actual files.
  cfg.dataDir = resolve(cfg.dataDir);
  if (cfg.configPath) cfg.configPath = resolve(cfg.configPath);
  for (const c of cfg.callers) c.apiKeyFile = resolve(c.apiKeyFile);
  if (process.platform !== 'linux') throw new Error('runAs requires Linux');
  if (process.getuid?.() === 0) throw new Error('runAs: run the daemon as an unprivileged service user, never root');
  if (cfg.callers.some((c) => !c.runAs && c.maxProfile === 'write')) {
    throw new Error('runAs: every write caller must use runAs when caller isolation is enabled; a legacy write shell has daemon authority');
  }
  // A caller must never be able to replace the helper or any of its parents.
  for (let p = cfg.userHelper; ; p = dirname(p)) {
    let st;
    try { st = lstatSync(p); } catch { throw new Error(`runAs: install -o root -g root -m 0755 scripts/swarmbase-user '${cfg.userHelper}' (create its root-owned parent directory first)`); }
    if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) throw new Error(`runAs: chown root:root '${p}' && chmod go-w '${p}' (no symlinks in userHelper path)`);
    if (p === cfg.userHelper && (!st.isFile() || !(st.mode & 0o111))) throw new Error(`runAs: chmod 0755 '${p}'`);
    if (dirname(p) === p) break;
  }
  const uids = new Set<number>();
  for (const c of isolated) {
    const provisional = { user: c.runAs!, root: c.homeDir ?? '/', helper: cfg.userHelper };
    // sudo resolves the account; the check request also proves the exact rule works.
    const needsBwrap = c.engines.includes('codex') && cfg.engines.codex.sandbox === 'bwrap';
    const info = operation(provisional, { op: 'check', paths: [], bwrap: needsBwrap });
    if (needsBwrap && !info.bwrapFd) throw new Error(`runAs: ${c.runAs} needs bubblewrap with --bind-fd and --ro-bind-fd; install a current bubblewrap package (0.10+ or a distro backport), or configure engines.codex.sandbox as "none" for write-trusted callers`);
    if (!Number.isInteger(info.uid) || !info.uid || info.uid === process.getuid?.() || uids.has(info.uid)) {
      throw new Error(`runAs: ${c.name} needs a distinct non-root uid, different from the daemon and every other caller`);
    }
    uids.add(info.uid);
    c.homeDir ??= info.home;
    const user = { ...provisional, root: realpathSync(c.homeDir!), cwdRoots: c.cwdRoots.map((r) => realpathSync(r)) };
    c.homeDir = user.root;
    const roots = [user.root, ...c.cwdRoots];
    for (const root of roots) {
      const st = statSync(root);
      if (!st.isDirectory() || st.uid !== info.uid || (st.mode & 0o007) || (st.mode & 0o020)) {
        throw new Error(`runAs: root '${root}' must belong to ${c.runAs} with a private group: chown ${c.runAs}:${c.runAs} '${root}' && chmod 2750 '${root}'; add the daemon to group ${c.runAs} and restart its login/service`);
      }
      if (root === user.root && st.gid !== info.gid && !(st.mode & 0o2000)) {
        throw new Error(`runAs: '${root}' needs group inheritance so the daemon can traverse new workspaces: chmod 2750 '${root}'`);
      }
      try { accessSync(root, constants.R_OK | constants.X_OK); } catch {
        throw new Error(`runAs: daemon needs traversal of '${root}': usermod -aG ${c.runAs} <daemon>; chmod 2750 '${root}'; restart the daemon's login/service`);
      }
    }
    accessSync(c.apiKeyFile, constants.R_OK);
    users.set(c.name, user);
  }
  // Private daemon data includes records, outbox, and all keys/bearers under it.
  const daemon = statSync(cfg.dataDir);
  if (daemon.uid !== process.getuid?.() || (daemon.mode & 0o077)) throw new Error(`runAs: chown <daemon> '${cfg.dataDir}' && chmod 0700 '${cfg.dataDir}'`);
  for (const [name, user] of users) {
    const paths = [cfg.dataDir, ...(cfg.configPath ? [cfg.configPath] : []),
      ...cfg.callers.filter((c) => c.name !== name).flatMap((c) => [c.apiKeyFile, ...(c.homeDir ? [c.homeDir] : []), ...c.cwdRoots])];
    const checks = operation(user, { op: 'check', paths });
    assertNoCallerAccess(user, checks.paths);
    // A 0600 file/0700 directory is insufficient if a caller can replace an
    // ancestor and redirect a future config/key read by the daemon.
    const parents = operation(user, { op: 'check', paths: protectedParents(paths) });
    for (const parent of parents.paths) {
      if (parent.write) throw new Error(`runAs: ${user.user} can replace protected paths under '${parent.path}'; move daemon files to a daemon-owned 0700 directory under a root-owned parent, and other callers' roots under a root-owned parent (chown root:root '${parent.path}' && chmod go-w '${parent.path}'); remove shared write ACLs with setfacl -b '${parent.path}'`);
    }
    const own = operation(user, { op: 'check', paths: [user.root, ...cfg.callers.find((c) => c.name === name)!.cwdRoots] });
    if (own.paths.some((p: any) => !p.read || !p.write || !p.execute)) throw new Error(`runAs: ${user.user} needs read/write/traverse on its own roots; chown ${user.user}:${user.user} '${user.root}' && chmod 2750 '${user.root}'`);
  }
  return users;
}

const controls = new WeakMap<ChildProcessWithoutNullStreams, boolean>();

export function spawnAgent(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  prompt: string, user?: CallerUser, files?: UserFiles, spawnProcess: typeof spawn = spawn): ChildProcessWithoutNullStreams {
  const plan = buildAgentLaunch(command, args, cwd, env, prompt, user, files);
  // The daemon cannot use a caller-owned cwd at spawn time; sudo must start in
  // a daemon-controlled directory and the helper chdirs after changing identity.
  const child = spawnProcess(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  child.stdin.on('error', () => {});
  if (plan.keepOpen) { controls.set(child, true); child.stdin.write(plan.input); }
  else child.stdin.end(plan.input);
  // Keep stdin open: control channel EOF (including daemon death) kills all
  // descendants. Credentials travel here, never in sudo/ps command arguments.
  return child;
}

export function signalAgent(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (controls.has(child)) {
    if (!child.stdin.destroyed) child.stdin.write(signal === 'SIGKILL' ? 'KILL\n' : 'TERM\n');
  } else if (child.pid !== undefined) {
    try { process.kill(-child.pid, signal); } catch { /* gone */ }
  }
}

export function agentHome(user: CallerUser, runId: string, n: number): string {
  return join(user.root, '.swarmbase', runId, `${n}-home`);
}
