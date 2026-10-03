/**
 * RunManager — owns live runs: the runner child per run, agent() admission
 * (policy, budget reservation, caps, resume cache), the two concurrency
 * levels, and the end-of-run bookkeeping that hands off to the Notifier.
 *
 * Budget model: every started agent RESERVES its cap (opts.maxUsd, default
 * max($0.50, budget/8)) and runs with `--max-budget-usd=<cap>`; spend is
 * settled when it ends and the unused part of the reservation returns. An agent
 * that can't get even a minimum reservation waits while others hold
 * reservations, and agent() throws once nothing is left. Overshoot is bounded
 * by one model turn per running agent (the CLI checks its cap per turn).
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { isUnder, profileRank, type CallerPolicy, type Config, type EngineName, type Profile } from './config.js';
import { killAllAgentGroups, runClaudeAgent, readApiKey, type Activity, type AgentOutcome } from './engines/claude.js';
import { Semaphore } from './semaphore.js';
import type { AgentDefaults, AgentStatus, RunMeta, RunStatus, RunStore } from './store.js';
import { wrapScript } from './runner/wrap.js';

const RUNNER_PATH = fileURLToPath(new URL('./runner/runner.js', import.meta.url));
const PKG_ROOT = resolve(dirname(RUNNER_PATH), '../../..');
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_RE = /^[A-Za-z0-9._:@/\[\]-]{1,100}$/;
const MIN_AGENT_USD = 0.03;
const MAX_LOG_EVENTS = 2000;
const MAX_PHASES = 100;
const WATCHDOG_INTERVAL_MS = 30_000;
const WATCHDOG_DEAD_MS = 120_000;
const FINISH_SETTLE_MS = 8_000;

export interface RunEndListener {
  runEnded(meta: RunMeta): void;
}

interface AgentSlot {
  ac: AbortController;
  status: AgentStatus;
  skipped: boolean;
}

interface ActiveRun {
  meta: RunMeta;
  caller: CallerPolicy;
  child: ChildProcess;
  agents: Map<number, AgentSlot>;
  inflight: Set<Promise<void>>;
  cache: Map<string, unknown[]>;
  runSem: Semaphore;
  agentSeq: number;
  reservedUsd: number;
  budgetWaiters: Set<() => void>;
  logCount: number;
  ending: boolean;
  timer: NodeJS.Timeout;
  watchdog: NodeJS.Timeout;
  lastPong: number;
  stderrTail: string;
}

export interface StartRunInput {
  caller: CallerPolicy;
  script: string;
  args: unknown;
  label: string | null;
  defaults: AgentDefaults;
  budgetUsd: number;
  resumeFrom: string | null;
}

interface ResolvedAgent {
  label: string;
  phase: string | null;
  schema: object | null;
  model: string;
  effort: string | null;
  profile: Profile;
  engine: EngineName;
  cwd: string;
  timeoutMs: number;
  maxUsd: number | null;
  warnings: string[];
}

export class RunManager {
  private active = new Map<string, ActiveRun>();
  private globalSem: Semaphore;

  constructor(
    private readonly cfg: Config,
    private readonly store: RunStore,
    private readonly emptyMcpConfigPath: string,
    private readonly listener: RunEndListener,
  ) {
    this.globalSem = new Semaphore(cfg.maxConcurrentAgents);
  }

  /** Compile-only syntax check (nothing executes), so `run` can refuse a broken script up front. */
  compileError(script: string): string | null {
    try {
      new vm.Script(wrapScript(script), { filename: 'workflow.js', lineOffset: -1 });
      return null;
    } catch (e) {
      const err = e as Error;
      const where = (err.stack ?? '').split('\n')[0];
      return `${err.name}: ${err.message}${where && !where.startsWith(err.name) ? ` (${where})` : ''}`;
    }
  }

  activeCount(caller: string): number {
    return [...this.active.values()].filter((r) => r.meta.caller === caller).length;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  stats(): { activeRuns: number; agentsRunning: number; agentsQueued: number } {
    return { activeRuns: this.active.size, agentsRunning: this.globalSem.active, agentsQueued: this.globalSem.queued };
  }

  start(input: StartRunInput): RunMeta {
    const meta = this.store.create({
      caller: input.caller.name,
      label: input.label,
      script: input.script,
      args: input.args,
      defaults: input.defaults,
      budgetUsd: input.budgetUsd,
      resumedFrom: input.resumeFrom,
    });
    this.store.emit(meta.id, { type: 'run_start', caller: meta.caller, label: meta.label, budgetUsd: meta.budgetUsd, resumedFrom: meta.resumedFrom });

    const child = fork(RUNNER_PATH, [], {
      execArgv: ['--experimental-permission', `--allow-fs-read=${PKG_ROOT}/*`, '--no-warnings'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, // nothing of the daemon's environment
    });
    const run: ActiveRun = {
      meta,
      caller: input.caller,
      child,
      agents: new Map(),
      inflight: new Set(),
      cache: input.resumeFrom ? this.store.readJournal(input.resumeFrom) : new Map(),
      runSem: new Semaphore(this.cfg.perRunConcurrency),
      agentSeq: 0,
      reservedUsd: 0,
      budgetWaiters: new Set(),
      logCount: 0,
      ending: false,
      timer: setTimeout(() => this.finish(run, 'failed', null, `run exceeded ${Math.round(this.cfg.runTimeoutMs / 60000)} min`), this.cfg.runTimeoutMs),
      watchdog: setInterval(() => {
        // A busy loop after the first await blocks the runner's event loop, so it
        // stops answering pings; the vm timeout only covers the synchronous start.
        if (Date.now() - run.lastPong > WATCHDOG_DEAD_MS) {
          this.finish(run, 'failed', null, `script runner unresponsive for ${WATCHDOG_DEAD_MS / 1000}s (busy loop?)`);
          return;
        }
        this.send(run, { type: 'ping' });
      }, WATCHDOG_INTERVAL_MS),
      lastPong: Date.now(),
      stderrTail: '',
    };
    this.active.set(meta.id, run);

    child.stderr?.on('data', (c: Buffer) => { run.stderrTail = (run.stderrTail + c.toString('utf8')).slice(-4000); });
    child.stdout?.on('data', () => { /* runner never writes stdout; drain anyway */ });
    child.on('message', (m) => {
      try { this.onChildMessage(run, m as Record<string, any>); }
      catch (e) { this.finish(run, 'failed', null, `internal error handling runner message: ${(e as Error).message}`); }
    });
    child.on('exit', (code, sig) => {
      if (!run.ending) this.finish(run, 'failed', null, `script runner exited unexpectedly (code ${code}, signal ${sig})${run.stderrTail ? `: ${run.stderrTail.trim().slice(-500)}` : ''}`);
    });
    child.on('error', (e) => {
      if (!run.ending) this.finish(run, 'failed', null, `script runner error: ${e.message}`);
    });
    child.send({ type: 'start', script: input.script, args: input.args, budgetUsd: meta.budgetUsd });
    return meta;
  }

  cancel(runId: string, by: string): boolean {
    const run = this.active.get(runId);
    if (!run || run.ending) return false;
    this.finish(run, 'cancelled', null, `cancelled by ${by}`);
    return true;
  }

  skipAgent(runId: string, n: number): boolean {
    const slot = this.active.get(runId)?.agents.get(n);
    if (!slot || (slot.status !== 'queued' && slot.status !== 'running')) return false;
    slot.skipped = true;
    slot.ac.abort();
    return true;
  }

  /** Daemon shutdown: stop every agent process. Runs stay `running` on disk and
   *  are marked interrupted on the next boot (see markOrphansInterrupted). */
  shutdown(): void {
    for (const run of this.active.values()) {
      run.ending = true;
      clearTimeout(run.timer);
      clearInterval(run.watchdog);
      for (const slot of run.agents.values()) slot.ac.abort();
      try { run.child.kill('SIGKILL'); } catch { /* gone */ }
    }
    killAllAgentGroups('SIGKILL');
  }

  markOrphansInterrupted(): RunMeta[] {
    const out: RunMeta[] = [];
    for (const meta of this.store.orphaned()) {
      meta.status = 'interrupted';
      meta.endedAt = new Date().toISOString();
      meta.error = 'SwarmBase restarted while this run was in flight; resume it to continue (finished agents are cached)';
      meta.counts.null += meta.counts.running + meta.counts.queued;
      meta.counts.running = 0;
      meta.counts.queued = 0;
      this.store.saveMeta(meta);
      this.store.emit(meta.id, { type: 'run_end', status: 'interrupted', spentUsd: meta.spentUsd, error: meta.error });
      out.push(meta);
    }
    return out;
  }

  // ── child protocol ─────────────────────────────────────────────────────

  private send(run: ActiveRun, m: Record<string, unknown>): void {
    if (run.ending || !run.child.connected) return;
    try { run.child.send(m); } catch { /* child went away; exit handler finishes the run */ }
  }

  private onChildMessage(run: ActiveRun, m: Record<string, any>): void {
    if (run.ending) return;
    const meta = run.meta;
    switch (m.type) {
      case 'pong':
        run.lastPong = Date.now();
        break;
      case 'meta': {
        let parsed: any = null;
        try { parsed = JSON.parse(String(m.json).slice(0, 20_000)); } catch { /* ignore */ }
        this.store.emit(meta.id, { type: 'meta', meta: parsed });
        if (!meta.label && parsed && typeof parsed.name === 'string') {
          meta.label = parsed.name.slice(0, 80);
          this.store.saveMeta(meta);
        }
        break;
      }
      case 'phase': {
        const title = String(m.title).slice(0, 120);
        if (title === meta.currentPhase) break;
        if (!meta.phases.includes(title)) {
          if (meta.phases.length >= MAX_PHASES) break;
          meta.phases.push(title);
        }
        meta.currentPhase = title;
        this.store.saveMeta(meta);
        this.store.emit(meta.id, { type: 'phase', title });
        break;
      }
      case 'log':
        run.logCount++;
        if (run.logCount < MAX_LOG_EVENTS) this.store.emit(meta.id, { type: 'log', message: String(m.message).slice(0, 4000) });
        else if (run.logCount === MAX_LOG_EVENTS) this.store.emit(meta.id, { type: 'log', message: `[swarmbase] log cap (${MAX_LOG_EVENTS}) reached; further log lines are dropped` });
        break;
      case 'agent': {
        const p = this.handleAgent(run, Number(m.callId), String(m.prompt), String(m.optsJson))
          .catch((e) => {
            console.error(`[swarmbase] run ${meta.id} agent handler failed:`, e);
            this.send(run, { type: 'agentError', callId: Number(m.callId), message: `internal error: ${(e as Error).message}` });
          });
        run.inflight.add(p);
        void p.finally(() => run.inflight.delete(p));
        break;
      }
      case 'done':
        this.finish(run, 'completed', String(m.json), null);
        break;
      case 'fail': {
        const stack = String(m.stack ?? '').split('\n').filter((l: string) => l.includes('workflow.js')).slice(0, 3).join(' | ');
        this.finish(run, 'failed', null, `${String(m.message).slice(0, 2000)}${stack ? ` [${stack.trim()}]` : ''}`);
        break;
      }
    }
  }

  /** End a run. Synchronously stops the script and aborts agents; the final
   *  bookkeeping and the notice wait (bounded) for aborted agents to settle so
   *  their spend and end states are in the record the caller is told about. */
  private finish(run: ActiveRun, status: RunStatus, resultJson: string | null, error: string | null): void {
    if (run.ending) return;
    run.ending = true;
    clearTimeout(run.timer);
    clearInterval(run.watchdog);
    for (const slot of run.agents.values()) if (slot.status === 'queued' || slot.status === 'running') slot.ac.abort();
    for (const w of run.budgetWaiters) w();
    try { run.child.kill('SIGKILL'); } catch { /* gone */ }

    const settle = Promise.race([
      Promise.allSettled([...run.inflight]),
      new Promise((r) => setTimeout(r, FINISH_SETTLE_MS)),
    ]);
    void settle.then(() => {
      const meta = run.meta;
      try {
        if (resultJson !== null) {
          let value: unknown = null;
          try { value = JSON.parse(resultJson); } catch { value = resultJson; }
          meta.resultChars = this.store.writeResult(meta, value);
        }
        meta.status = status;
        meta.error = error;
        meta.endedAt = new Date().toISOString();
        this.store.saveMeta(meta);
        this.store.emit(meta.id, { type: 'run_end', status, spentUsd: meta.spentUsd, error });
      } catch (e) {
        console.error(`[swarmbase] run ${meta.id} final bookkeeping failed:`, e);
      }
      this.active.delete(meta.id);
      try { this.listener.runEnded(meta); } catch (e) { console.error('[swarmbase] runEnded listener failed:', e); }
    });
  }

  // ── agent() admission and execution ────────────────────────────────────

  private setStatus(run: ActiveRun, slot: AgentSlot | null, status: AgentStatus): void {
    const c = run.meta.counts;
    if (slot) { c[slot.status] = Math.max(0, c[slot.status] - 1); slot.status = status; }
    c[status]++;
  }

  private resolveAgent(run: ActiveRun, n: number, opts: Record<string, any>): ResolvedAgent {
    const caller = run.caller;
    const d = run.meta.defaults;
    const warnings: string[] = [];

    const engine = (opts.engine ?? 'claude') as EngineName;
    if (!caller.engines.includes(engine)) throw new Error(`engine "${opts.engine}" is not available to you (available: ${caller.engines.join(', ')})`);

    const defaultProfile: Profile = profileRank(caller.maxProfile) >= profileRank('read') ? 'read' : caller.maxProfile;
    const profile = (opts.profile ?? d.profile ?? defaultProfile) as Profile;
    if (!['think', 'read', 'write'].includes(profile)) throw new Error(`unknown profile "${profile}" (think | read | write)`);
    if (profileRank(profile) > profileRank(caller.maxProfile)) throw new Error(`profile "${profile}" exceeds your maximum "${caller.maxProfile}"`);

    const model = String(opts.model ?? d.model ?? caller.defaultModel);
    if (!MODEL_RE.test(model)) throw new Error(`bad model id ${JSON.stringify(model)}`);

    const effortRaw = opts.effort ?? d.effort ?? null;
    const effort = effortRaw === null ? null : String(effortRaw);
    if (effort !== null && !EFFORTS.has(effort)) throw new Error(`bad effort "${effort}" (low | medium | high | xhigh | max)`);

    let cwd = realpathSync(this.store.workDir(run.meta));
    if (opts.cwd !== undefined) {
      const want = String(opts.cwd);
      if (!isAbsolute(want)) throw new Error('cwd must be an absolute path');
      if (!existsSync(want) || !statSync(want).isDirectory()) throw new Error(`cwd ${want} is not a directory`);
      const real = realpathSync(want); // pin the resolved path: a later symlink swap can't move the agent
      if (!caller.cwdRoots.some((root) => isUnder(real, root))) {
        throw new Error(`cwd ${want} is outside your allowed roots (${caller.cwdRoots.join(', ') || 'none — only the run work dir'})`);
      }
      cwd = real;
    }

    if (opts.isolation !== undefined) throw new Error(`isolation: "${opts.isolation}" is not supported by SwarmBase yet`);
    if (opts.agentType !== undefined) warnings.push(`agentType "${opts.agentType}" ignored (not supported)`);

    let schema: object | null = null;
    if (opts.schema !== undefined && opts.schema !== null) {
      if (typeof opts.schema !== 'object' || Array.isArray(opts.schema) || opts.schema.type !== 'object') {
        throw new Error('schema must be a JSON Schema object with type: "object" at the root');
      }
      schema = opts.schema;
    }

    let maxUsd: number | null = null;
    if (opts.maxUsd !== undefined) {
      const v = Number(opts.maxUsd);
      if (!Number.isFinite(v) || v <= 0) throw new Error('maxUsd must be a positive number');
      maxUsd = v;
    }

    const timeoutMs = Math.min(this.cfg.agentTimeoutMs, Math.max(10_000, Number(opts.timeoutMs ?? this.cfg.agentTimeoutMs) || this.cfg.agentTimeoutMs));
    const label = typeof opts.label === 'string' && opts.label.trim() ? opts.label.trim().slice(0, 80) : `agent-${n}`;
    const phase = typeof opts.phase === 'string' ? opts.phase.slice(0, 120) : run.meta.currentPhase;
    return { label, phase, schema, model, effort, profile, engine, cwd, timeoutMs, maxUsd, warnings };
  }

  private available(run: ActiveRun): number {
    return run.meta.budgetUsd - run.meta.spentUsd - run.reservedUsd;
  }

  /** Reserve this agent's cap, waiting while other agents hold reservations.
   *  Returns the reserved amount, or null when the budget is exhausted / aborted. */
  private async reserve(run: ActiveRun, want: number, signal: AbortSignal): Promise<number | null> {
    for (;;) {
      if (signal.aborted || run.ending) return null;
      const avail = this.available(run);
      if (avail >= MIN_AGENT_USD) {
        const cap = Math.min(want, avail);
        run.reservedUsd += cap;
        return cap;
      }
      if (run.reservedUsd <= 0) return null; // nothing will come back
      await new Promise<void>((res) => {
        const wake = () => { run.budgetWaiters.delete(wake); signal.removeEventListener('abort', wake); res(); };
        run.budgetWaiters.add(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
  }

  private release(run: ActiveRun, reserved: number, spent: number): void {
    run.reservedUsd = Math.max(0, run.reservedUsd - reserved);
    run.meta.spentUsd += spent;
    for (const w of [...run.budgetWaiters]) w();
  }

  private async handleAgent(run: ActiveRun, callId: number, prompt: string, optsJson: string): Promise<void> {
    const meta = run.meta;
    const replyOk = (value: unknown) => this.send(run, { type: 'agentResult', callId, json: JSON.stringify(value ?? null) });
    const replyErr = (message: string) => this.send(run, { type: 'agentError', callId, message });

    let opts: Record<string, any>;
    try {
      const parsed = JSON.parse(optsJson);
      opts = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { opts = {}; }

    if (run.agentSeq >= this.cfg.maxAgentsPerRun) {
      replyErr(`agent cap reached (${this.cfg.maxAgentsPerRun} per run)`);
      return;
    }
    const n = ++run.agentSeq;
    let a: ResolvedAgent;
    try {
      a = this.resolveAgent(run, n, opts);
    } catch (e) {
      replyErr(`agent(): ${(e as Error).message}`);
      return;
    }
    for (const w of a.warnings) this.store.emit(meta.id, { type: 'log', message: `[swarmbase] agent ${n}: ${w}` });

    // Resume cache first: a cached answer costs nothing, so it is served even
    // when the budget is spent. Keyed over everything that shapes the answer.
    const key = createHash('sha256')
      .update(JSON.stringify([prompt, a.schema, a.model, a.effort, a.profile, a.engine, a.cwd === realpathSync(this.store.workDir(meta)) ? null : a.cwd]))
      .digest('hex');
    const cached = opts.fresh ? undefined : run.cache.get(key);
    if (cached && cached.length) {
      const value = cached.shift();
      meta.agentsTotal = n;
      this.store.writeAgentInput(meta, n, prompt, a.schema);
      this.store.emit(meta.id, { type: 'agent_queued', n, label: a.label, phase: a.phase, engine: a.engine, model: a.model, profile: a.profile, effort: a.effort, promptPreview: prompt.slice(0, 600) });
      this.setStatus(run, null, 'cached');
      this.store.appendJournal(meta, { key, n, label: a.label, result: value, costUsd: 0 });
      this.store.emit(meta.id, { type: 'agent_end', n, status: 'cached', costUsd: 0, durationMs: 0, resultPreview: preview(value) });
      this.store.saveMeta(meta);
      replyOk(value);
      return;
    }

    if (this.available(run) < MIN_AGENT_USD && run.reservedUsd <= 0) {
      replyErr(`budget exhausted: $${meta.spentUsd.toFixed(2)} of $${meta.budgetUsd.toFixed(2)} spent`);
      return;
    }

    meta.agentsTotal = n;
    this.store.writeAgentInput(meta, n, prompt, a.schema);
    this.store.emit(meta.id, {
      type: 'agent_queued', n, label: a.label, phase: a.phase, engine: a.engine, model: a.model,
      profile: a.profile, effort: a.effort, promptPreview: prompt.slice(0, 600),
    });

    const slot: AgentSlot = { ac: new AbortController(), status: 'queued', skipped: false };
    run.agents.set(n, slot);
    this.setStatus(run, null, 'queued');
    this.store.saveMeta(meta);

    const endEarly = (why: string, budget: boolean) => {
      this.setStatus(run, slot, slot.skipped ? 'skipped' : 'null');
      this.store.emit(meta.id, { type: 'agent_end', n, status: slot.status, costUsd: 0, durationMs: 0, error: slot.skipped ? 'skipped before start' : why });
      this.store.saveMeta(meta);
      if (budget && !slot.skipped) replyErr(`budget exhausted: $${meta.spentUsd.toFixed(2)} of $${meta.budgetUsd.toFixed(2)} spent`);
      else replyOk(null);
    };

    // run slot → budget reservation → global slot
    try { await run.runSem.acquire(slot.ac.signal); }
    catch { endEarly('run ended before start', false); return; }
    const want = a.maxUsd ?? Math.max(0.5, meta.budgetUsd / 8);
    const reserved = await this.reserve(run, want, slot.ac.signal);
    if (reserved === null) {
      run.runSem.release();
      endEarly(slot.ac.signal.aborted || run.ending ? 'run ended before start' : 'budget exhausted', !(slot.ac.signal.aborted || run.ending));
      return;
    }
    try { await this.globalSem.acquire(slot.ac.signal); }
    catch {
      run.runSem.release();
      this.release(run, reserved, 0);
      endEarly('run ended before start', false);
      return;
    }

    this.setStatus(run, slot, 'running');
    this.store.saveMeta(meta);
    this.store.emit(meta.id, { type: 'agent_start', n });

    let lastActivityAt = 0;
    const onActivity = (act: Activity) => {
      const now = Date.now();
      if (now - lastActivityAt < 2000) return;
      lastActivityAt = now;
      this.store.emit(meta.id, { type: 'agent_activity', n, kind: act.kind, summary: act.summary });
    };

    let outcome: AgentOutcome;
    try {
      outcome = await runClaudeAgent({
        runId: meta.id,
        n,
        label: a.label,
        prompt,
        schema: a.schema,
        model: a.model,
        effort: a.effort,
        profile: a.profile,
        cwd: a.cwd,
        timeoutMs: a.timeoutMs,
        maxBudgetUsd: reserved,
        streamPath: this.store.agentStreamPath(meta, n),
        apiKey: readApiKey(run.caller.apiKeyFile),
        apiBaseUrl: this.cfg.apiBaseUrl,
        claudeBin: this.cfg.claudeBin,
        emptyMcpConfigPath: this.emptyMcpConfigPath,
        dataDir: realpathSync(this.cfg.dataDir),
      }, slot.ac.signal, onActivity);
    } catch (e) {
      outcome = { ok: false, result: null, costUsd: 0, durationMs: 0, usage: null, error: (e as Error).message, reason: 'exit' };
    } finally {
      this.globalSem.release();
      run.runSem.release();
    }

    this.release(run, reserved, outcome.costUsd);
    this.send(run, { type: 'spent', usd: meta.spentUsd });
    let status: AgentStatus;
    if (outcome.ok) status = 'ok';
    else if (slot.skipped) status = 'skipped';
    else if (outcome.reason === 'cancelled') status = 'null';
    else status = 'error';
    this.setStatus(run, slot, status);
    if (outcome.ok) this.store.appendJournal(meta, { key, n, label: a.label, result: outcome.result, costUsd: outcome.costUsd });
    let error = slot.skipped ? 'skipped by operator' : (outcome.error ?? 'failed');
    if (!outcome.ok && /max_budget/.test(error)) error = `hit its $${reserved.toFixed(2)} cap (raise opts.maxUsd or the run budget) — ${error}`;
    this.store.emit(meta.id, {
      type: 'agent_end', n, status, costUsd: outcome.costUsd, durationMs: outcome.durationMs,
      usage: outcome.usage ?? undefined,
      ...(outcome.ok ? { resultPreview: preview(outcome.result) } : { error }),
    });
    this.store.saveMeta(meta);
    replyOk(outcome.ok ? outcome.result : null);
  }
}

function preview(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? 'null').slice(0, 400);
}
