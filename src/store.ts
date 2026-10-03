/**
 * Run store. One directory per run under <dataDir>/runs, named
 * `<UTC stamp>-<runId>` so retention can go by the name, never by mtime.
 *
 *   meta.json      current summary (rewritten via tmp+rename)
 *   script.js      the submitted script, verbatim
 *   args.json      the submitted args
 *   events.jsonl   append-only, monotonic `seq` — the dashboard's source of truth
 *   journal.jsonl  one line per non-null agent result, keyed for resume
 *   result.json    the script's return value
 *   agents/<n>.jsonl  raw engine stream for agent n
 *   work/          default cwd for subagents
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Profile } from './config.js';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type AgentStatus = 'queued' | 'running' | 'ok' | 'null' | 'skipped' | 'cached' | 'error';

export interface AgentDefaults {
  model?: string;
  effort?: string;
  profile?: Profile;
}

export interface RunMeta {
  id: string;
  dir: string;
  caller: string;
  label: string | null;
  status: RunStatus;
  createdAt: string;
  endedAt: string | null;
  defaults: AgentDefaults;
  budgetUsd: number;
  spentUsd: number;
  counts: Record<AgentStatus, number>;
  agentsTotal: number;
  currentPhase: string | null;
  phases: string[];
  resumedFrom: string | null;
  error: string | null;
  resultChars: number | null;
}

export type RunEvent = { seq: number; ts: string } & (
  | { type: 'run_start'; caller: string; label: string | null; budgetUsd: number; resumedFrom: string | null }
  | { type: 'meta'; meta: unknown }
  | { type: 'phase'; title: string }
  | { type: 'log'; message: string }
  | { type: 'agent_queued'; n: number; label: string; phase: string | null; engine: string; model: string; profile: Profile; effort: string | null; promptPreview: string }
  | { type: 'agent_start'; n: number }
  | { type: 'agent_activity'; n: number; kind: string; summary: string }
  | { type: 'agent_end'; n: number; status: AgentStatus; costUsd: number; durationMs: number; error?: string; resultPreview?: string; usage?: unknown }
  | { type: 'run_end'; status: RunStatus; spentUsd: number; error: string | null }
);

/** Distributive Omit, so each event variant keeps its own fields. */
export type NewRunEvent = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, 'seq' | 'ts'> : never) : never;

const EMPTY_COUNTS = (): Record<AgentStatus, number> => ({ queued: 0, running: 0, ok: 0, null: 0, skipped: 0, cached: 0, error: 0 });

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function newRunId(): string {
  return 'r' + randomBytes(4).toString('hex');
}

type Listener = (e: RunEvent) => void;

export class RunStore {
  readonly runsDir: string;
  private metas = new Map<string, RunMeta>();
  private seqs = new Map<string, number>();
  private listeners = new Map<string, Set<Listener>>();
  private globalListeners = new Set<(m: RunMeta) => void>();

  constructor(dataDir: string) {
    this.runsDir = join(dataDir, 'runs');
    mkdirSync(this.runsDir, { recursive: true });
    this.loadAll();
  }

  private loadAll(): void {
    for (const name of readdirSync(this.runsDir)) {
      const dir = join(this.runsDir, name);
      const metaPath = join(dir, 'meta.json');
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as RunMeta;
        meta.dir = dir;
        this.metas.set(meta.id, meta);
        this.seqs.set(meta.id, this.readEvents(meta.id).reduce((m, e) => Math.max(m, e.seq), 0));
      } catch (e) {
        console.error(`[swarmbase] skipping unreadable run ${name}: ${(e as Error).message}`);
      }
    }
  }

  /** Runs that were mid-flight when the daemon died. */
  orphaned(): RunMeta[] {
    return [...this.metas.values()].filter((m) => m.status === 'running');
  }

  create(input: { caller: string; label: string | null; script: string; args: unknown; defaults: AgentDefaults; budgetUsd: number; resumedFrom: string | null }): RunMeta {
    const id = newRunId();
    const dir = join(this.runsDir, `${stamp()}-${id}`);
    mkdirSync(join(dir, 'agents'), { recursive: true });
    mkdirSync(join(dir, 'work'), { recursive: true });
    writeFileSync(join(dir, 'script.js'), input.script);
    writeFileSync(join(dir, 'args.json'), JSON.stringify(input.args ?? null, null, 2));
    const meta: RunMeta = {
      id, dir,
      caller: input.caller,
      label: input.label,
      status: 'running',
      createdAt: new Date().toISOString(),
      endedAt: null,
      defaults: input.defaults,
      budgetUsd: input.budgetUsd,
      spentUsd: 0,
      counts: EMPTY_COUNTS(),
      agentsTotal: 0,
      currentPhase: null,
      phases: [],
      resumedFrom: input.resumedFrom,
      error: null,
      resultChars: null,
    };
    this.metas.set(id, meta);
    this.seqs.set(id, 0);
    this.saveMeta(meta);
    return meta;
  }

  get(id: string): RunMeta | undefined {
    return this.metas.get(id);
  }

  list(filter?: { caller?: string; status?: RunStatus }): RunMeta[] {
    return [...this.metas.values()]
      .filter((m) => (!filter?.caller || m.caller === filter.caller) && (!filter?.status || m.status === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  saveMeta(meta: RunMeta): void {
    const p = join(meta.dir, 'meta.json');
    writeFileSync(p + '.tmp', JSON.stringify(meta, null, 2));
    renameSync(p + '.tmp', p);
    for (const l of this.globalListeners) { try { l(meta); } catch { /* listener bugs never break the run */ } }
  }

  emit(id: string, event: NewRunEvent): RunEvent {
    const meta = this.metas.get(id);
    if (!meta) throw new Error(`unknown run ${id}`);
    const seq = (this.seqs.get(id) ?? 0) + 1;
    this.seqs.set(id, seq);
    const full = { ...event, seq, ts: new Date().toISOString() } as RunEvent;
    appendFileSync(join(meta.dir, 'events.jsonl'), JSON.stringify(full) + '\n');
    for (const l of this.listeners.get(id) ?? []) { try { l(full); } catch { /* ignore */ } }
    return full;
  }

  readEvents(id: string, sinceSeq = 0): RunEvent[] {
    const meta = this.metas.get(id);
    if (!meta) return [];
    const p = join(meta.dir, 'events.jsonl');
    if (!existsSync(p)) return [];
    const out: RunEvent[] = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as RunEvent;
        if (e.seq > sinceSeq) out.push(e);
      } catch { /* torn tail line after a crash */ }
    }
    return out;
  }

  subscribe(id: string, l: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) { set = new Set(); this.listeners.set(id, set); }
    set.add(l);
    return () => { set!.delete(l); };
  }

  onMeta(l: (m: RunMeta) => void): () => void {
    this.globalListeners.add(l);
    return () => { this.globalListeners.delete(l); };
  }

  readScript(id: string): string | null {
    const meta = this.metas.get(id);
    if (!meta) return null;
    try { return readFileSync(join(meta.dir, 'script.js'), 'utf8'); } catch { return null; }
  }

  readArgs(id: string): unknown {
    const meta = this.metas.get(id);
    if (!meta) return null;
    try { return JSON.parse(readFileSync(join(meta.dir, 'args.json'), 'utf8')); } catch { return null; }
  }

  writeResult(meta: RunMeta, result: unknown): number {
    const text = JSON.stringify(result ?? null, null, 2);
    writeFileSync(join(meta.dir, 'result.json'), text);
    return text.length;
  }

  readResultText(id: string): string | null {
    const meta = this.metas.get(id);
    if (!meta) return null;
    const p = join(meta.dir, 'result.json');
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  appendJournal(meta: RunMeta, entry: { key: string; n: number; label: string; result: unknown; costUsd: number }): void {
    appendFileSync(join(meta.dir, 'journal.jsonl'), JSON.stringify(entry) + '\n');
  }

  /** key → queue of cached results (a key can legitimately repeat). */
  readJournal(id: string): Map<string, unknown[]> {
    const out = new Map<string, unknown[]>();
    const meta = this.metas.get(id);
    if (!meta) return out;
    const p = join(meta.dir, 'journal.jsonl');
    if (!existsSync(p)) return out;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { key: string; result: unknown };
        const q = out.get(e.key) ?? [];
        q.push(e.result);
        out.set(e.key, q);
      } catch { /* torn line */ }
    }
    return out;
  }

  writeAgentInput(meta: RunMeta, n: number, prompt: string, schema: object | null): void {
    writeFileSync(join(meta.dir, 'agents', `${n}.prompt.txt`), prompt);
    if (schema) writeFileSync(join(meta.dir, 'agents', `${n}.schema.json`), JSON.stringify(schema, null, 2));
  }

  readAgentFile(id: string, n: number, suffix: '.jsonl' | '.prompt.txt' | '.schema.json'): string | null {
    const meta = this.metas.get(id);
    if (!meta || !Number.isInteger(n) || n < 1) return null;
    const p = join(meta.dir, 'agents', `${n}${suffix}`);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  agentStreamPath(meta: RunMeta, n: number): string {
    return join(meta.dir, 'agents', `${n}.jsonl`);
  }

  workDir(meta: RunMeta): string {
    return join(meta.dir, 'work');
  }
}
