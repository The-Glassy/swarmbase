/** The caller-facing MCPL tools. Through these, callers only ever see their own runs
 *  (the tailnet dashboard is the operator's view of all of them). */
import { PROFILES, profileRank, type CallerPolicy, type Config, type Profile } from './config.js';
import { guideText } from './guide.js';
import { countsLine, fmtDuration, type Notifier } from './notifier.js';
import type { RunManager } from './runs.js';
import type { ToolHost, ToolResult } from './session.js';
import type { RunEvent, RunMeta, RunStatus, RunStore } from './store.js';

const MAX_SCRIPT_CHARS = 200_000;
const MAX_ARGS_CHARS = 2_000_000;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export class SwarmTools implements ToolHost {
  constructor(
    private readonly cfg: Config,
    private readonly store: RunStore,
    private readonly runs: RunManager,
    private readonly notifier: Notifier,
  ) {}

  toolDefinitions(): unknown[] {
    const runProps = {
      label: { type: 'string', description: 'Short name for the dashboard and the completion notice.' },
      model: { type: 'string', description: 'Default Claude model for this run\'s claude-engine agents (agent() opts override; codex agents use the caller\'s codex default).' },
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Default effort for this run\'s agents.' },
      profile: { type: 'string', enum: [...PROFILES], description: 'Default tool profile: think (no tools) | read | write.' },
      budgetUsd: { type: 'number', description: 'Hard USD ceiling for the run; agent() throws once it is spent.' },
    };
    return [
      {
        name: 'run',
        description: 'Start a SwarmBase run: a JavaScript orchestration script that fans out subagents via agent() / parallel() / pipeline(). Returns a runId immediately; you are notified with the result when the run ends. Read `guide` before your first script.',
        inputSchema: {
          type: 'object',
          properties: {
            script: { type: 'string', description: 'The script body (plain JS; top-level await/return).' },
            args: { description: 'Any JSON value, exposed to the script as `args`.' },
            ...runProps,
          },
          required: ['script'],
        },
      },
      {
        name: 'status',
        description: 'Progress of a run: phases, each agent\'s state and cost, recent log lines.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
      },
      {
        name: 'result',
        description: 'Read a finished run\'s return value (JSON text), paged.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            offset: { type: 'number', description: 'Character offset (default 0).' },
            maxChars: { type: 'number', description: 'Characters to return (default 20000, max 100000).' },
          },
          required: ['runId'],
        },
      },
      {
        name: 'cancel',
        description: 'Cancel a running run (its agents are stopped; finished results stay cached for resume).',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
      },
      {
        name: 'list',
        description: 'Your recent runs.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Default 10.' },
            status: { type: 'string', enum: ['running', 'completed', 'failed', 'cancelled', 'interrupted'] },
          },
        },
      },
      {
        name: 'resume',
        description: 'Start a new run from an earlier one: same script and args unless you pass new ones; agent() calls identical to ones that already succeeded are answered from the earlier run\'s journal at no cost.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'The run to resume from.' },
            script: { type: 'string', description: 'Edited script (optional).' },
            args: { description: 'New args (optional).' },
            ...runProps,
          },
          required: ['runId'],
        },
      },
      {
        name: 'guide',
        description: 'The SwarmBase script authoring reference: hooks, agent() options, profiles, budget, resume, patterns.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async callTool(caller: CallerPolicy, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'run': return this.startRun(caller, args, null);
        case 'resume': return this.resume(caller, args);
        case 'status': return this.status(caller, args);
        case 'result': return this.result(caller, args);
        case 'cancel': return this.cancel(caller, args);
        case 'list': return this.list(caller, args);
        case 'guide': return text(guideText({
          defaultModel: caller.defaultModel,
          engines: caller.engines,
          defaultModels: caller.defaultModels,
          maxProfile: caller.maxProfile,
          budgetDefault: caller.runUsdDefault,
          budgetMax: caller.runUsdMax,
          maxAgents: this.cfg.maxAgentsPerRun,
          perRun: this.cfg.perRunConcurrency,
          cwdRoots: caller.cwdRoots,
        }));
        default: return text(`Unknown tool: ${name}`, true);
      }
    } catch (e) {
      return text(`swarmbase ${name} failed: ${(e as Error).message}`, true);
    }
  }

  private own(caller: CallerPolicy, args: Record<string, unknown>): RunMeta {
    const id = String(args.runId ?? '').trim();
    const meta = this.store.get(id);
    if (!meta || meta.caller !== caller.name) throw new Error(`no run "${id}" of yours`);
    return meta;
  }

  private startRun(caller: CallerPolicy, args: Record<string, unknown>, resumeFrom: RunMeta | null): ToolResult {
    const script = typeof args.script === 'string' ? args.script : resumeFrom ? this.store.readScript(resumeFrom.id) : null;
    if (!script || !script.trim()) return text('run needs a non-empty `script`.', true);
    if (script.length > MAX_SCRIPT_CHARS) return text(`script is ${script.length} chars; the limit is ${MAX_SCRIPT_CHARS}. Put bulk data in args.`, true);
    const runArgs = 'args' in args ? args.args : resumeFrom ? this.store.readArgs(resumeFrom.id) : undefined;
    const argsLen = runArgs === undefined ? 0 : JSON.stringify(runArgs).length;
    if (argsLen > MAX_ARGS_CHARS) return text(`args are ${argsLen} chars; the limit is ${MAX_ARGS_CHARS}.`, true);

    const compileError = this.runs.compileError(script);
    if (compileError) return text(`Script does not compile — nothing was started.\n${compileError}`, true);

    const active = this.runs.activeCount(caller.name);
    if (active >= caller.maxActiveRuns) return text(`You already have ${active} run(s) in flight (limit ${caller.maxActiveRuns}). Wait for one to end or cancel one.`, true);

    let budgetUsd = caller.runUsdDefault;
    if (args.budgetUsd !== undefined) {
      const b = Number(args.budgetUsd);
      if (!Number.isFinite(b) || b <= 0) return text('budgetUsd must be a positive number.', true);
      if (b > caller.runUsdMax) return text(`budgetUsd ${b} exceeds your per-run maximum of $${caller.runUsdMax}.`, true);
      budgetUsd = b;
    } else if (resumeFrom) {
      budgetUsd = Math.min(resumeFrom.budgetUsd, caller.runUsdMax);
    }

    const profile = args.profile ?? resumeFrom?.defaults.profile;
    if (profile !== undefined && !(PROFILES as readonly string[]).includes(String(profile))) return text(`unknown profile "${profile}".`, true);
    if (profile !== undefined && profileRank(profile as Profile) > profileRank(caller.maxProfile)) {
      return text(`profile "${profile}" exceeds your maximum "${caller.maxProfile}".`, true);
    }
    const defaults = {
      ...(args.model ?? resumeFrom?.defaults.model ? { model: String(args.model ?? resumeFrom?.defaults.model) } : {}),
      ...(args.effort ?? resumeFrom?.defaults.effort ? { effort: String(args.effort ?? resumeFrom?.defaults.effort) } : {}),
      ...(profile !== undefined ? { profile: profile as Profile } : {}),
    };
    const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim().slice(0, 80) : (resumeFrom?.label ?? null);

    const meta = this.runs.start({ caller, script, args: runArgs, label, defaults, budgetUsd, resumeFrom: resumeFrom?.id ?? null });
    const url = this.notifier.runUrl(meta.id);
    return text([
      `Started run ${meta.id}${label ? ` "${label}"` : ''} — budget $${budgetUsd.toFixed(2)}${resumeFrom ? `, resuming from ${resumeFrom.id} (cached agent results replay free)` : ''}.`,
      'You will get a [swarmbase] notice when it ends. `status` shows progress meanwhile.',
      ...(url ? [`Dashboard: ${url}`] : []),
    ].join('\n'));
  }

  private resume(caller: CallerPolicy, args: Record<string, unknown>): ToolResult {
    const from = this.own(caller, args);
    if (this.runs.isActive(from.id)) return text(`Run ${from.id} is still running; cancel it first or wait for it to end.`, true);
    return this.startRun(caller, args, from);
  }

  private status(caller: CallerPolicy, args: Record<string, unknown>): ToolResult {
    const meta = this.own(caller, args);
    return text(statusText(meta, this.store.readEvents(meta.id), this.notifier.runUrl(meta.id)));
  }

  private result(caller: CallerPolicy, args: Record<string, unknown>): ToolResult {
    const meta = this.own(caller, args);
    if (meta.status === 'running') return text(`Run ${meta.id} is still running.`, true);
    const all = this.store.readResultText(meta.id);
    if (all === null) return text(`Run ${meta.id} ${meta.status} without a return value.${meta.error ? ` Error: ${meta.error}` : ''}`);
    const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
    const maxChars = Math.min(100_000, Math.max(1, Math.floor(Number(args.maxChars ?? 20_000)) || 20_000));
    const slice = all.slice(offset, offset + maxChars);
    const end = offset + slice.length;
    return text(`[chars ${offset}–${end} of ${all.length}${end < all.length ? `; next offset ${end}` : '; end'}]\n${slice}`);
  }

  private cancel(caller: CallerPolicy, args: Record<string, unknown>): ToolResult {
    const meta = this.own(caller, args);
    if (!this.runs.cancel(meta.id, caller.name)) return text(`Run ${meta.id} is not running (${meta.status}).`);
    return text(`Cancelled run ${meta.id}. ${meta.counts.ok} finished agent result(s) stay cached for resume.`);
  }

  private list(caller: CallerPolicy, args: Record<string, unknown>): ToolResult {
    const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit ?? 10)) || 10));
    const status = typeof args.status === 'string' ? (args.status as RunStatus) : undefined;
    const runs = this.store.list({ caller: caller.name, status }).slice(0, limit);
    if (!runs.length) return text('No runs yet.');
    return text(runs.map((m) => {
      const took = fmtDuration((m.endedAt ? Date.parse(m.endedAt) : Date.now()) - Date.parse(m.createdAt));
      return `${m.id} ${m.status.padEnd(11)} ${m.createdAt.slice(0, 16)}Z ${took.padStart(7)} $${m.spentUsd.toFixed(2)} ${m.agentsTotal} agents${m.label ? ` — ${m.label}` : ''}`;
    }).join('\n'));
  }
}

interface AgentRow { n: number; label: string; phase: string | null; model: string; status: string; cost: number; ms: number; activity: string | null; error: string | null }

export function agentRows(events: RunEvent[]): AgentRow[] {
  const rows = new Map<number, AgentRow>();
  for (const e of events) {
    if (e.type === 'agent_queued') rows.set(e.n, { n: e.n, label: e.label, phase: e.phase, model: e.model, status: 'queued', cost: 0, ms: 0, activity: null, error: null });
    else if (e.type === 'agent_start') { const r = rows.get(e.n); if (r) r.status = 'running'; }
    else if (e.type === 'agent_activity') { const r = rows.get(e.n); if (r) r.activity = `${e.kind}: ${e.summary}`; }
    else if (e.type === 'agent_end') {
      const r = rows.get(e.n);
      if (r) { r.status = e.status; r.cost = e.costUsd; r.ms = e.durationMs; r.error = e.error ?? null; }
    }
  }
  return [...rows.values()];
}

export function statusText(meta: RunMeta, events: RunEvent[], url: string | null): string {
  const took = fmtDuration((meta.endedAt ? Date.parse(meta.endedAt) : Date.now()) - Date.parse(meta.createdAt));
  const lines = [
    `Run ${meta.id}${meta.label ? ` "${meta.label}"` : ''} — ${meta.status}${meta.currentPhase ? ` · phase "${meta.currentPhase}"` : ''} · ${countsLine(meta)} · $${meta.spentUsd.toFixed(2)} of $${meta.budgetUsd.toFixed(2)} · ${took}`,
  ];
  if (meta.error) lines.push(`Error: ${meta.error}`);
  if (meta.phases.length) lines.push(`Phases: ${meta.phases.join(' → ')}`);
  const rows = agentRows(events);
  const shown = rows.length > 40 ? [...rows.filter((r) => r.status === 'running' || r.status === 'error'), ...rows.slice(-20)] : rows;
  const seen = new Set<number>();
  if (rows.length) lines.push('Agents:');
  for (const r of shown) {
    if (seen.has(r.n)) continue;
    seen.add(r.n);
    const tail = r.status === 'running' && r.activity ? ` · ${r.activity.slice(0, 100)}` : r.error ? ` · ${r.error.slice(0, 120)}` : '';
    lines.push(`  #${r.n} ${r.label}${r.phase ? ` [${r.phase}]` : ''} ${r.status} · ${r.model} · $${r.cost.toFixed(3)}${r.ms ? ` · ${fmtDuration(r.ms)}` : ''}${tail}`);
  }
  if (rows.length > seen.size) lines.push(`  (${rows.length - seen.size} more not shown)`);
  const logs = events.filter((e): e is Extract<RunEvent, { type: 'log' }> => e.type === 'log').slice(-8);
  if (logs.length) {
    lines.push('Recent log:');
    for (const l of logs) lines.push(`  ${l.message.slice(0, 300)}`);
  }
  if (url) lines.push(`Dashboard: ${url}`);
  return lines.join('\n');
}
