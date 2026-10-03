/**
 * Notifier — turns run endings into push/events for the run's caller, with a
 * persisted per-caller outbox so a resident that is offline (restarting,
 * reconnecting) still gets told when it comes back. eventId = `<runId>:end`,
 * so a redelivery after an ambiguous failure is deduplicated host-side.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { RunEndListener } from './runs.js';
import type { Session } from './session.js';
import type { RunMeta, RunStore } from './store.js';

interface Notice { eventId: string; runId: string; text: string; createdAt: string }

const OUTBOX_CAP = 50;

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function countsLine(meta: RunMeta): string {
  const c = meta.counts;
  const parts = [`${c.ok} ok`];
  if (c.cached) parts.push(`${c.cached} cached`);
  if (c.null + c.error) parts.push(`${c.null + c.error} null`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  if (c.running) parts.push(`${c.running} running`);
  if (c.queued) parts.push(`${c.queued} queued`);
  return `${meta.agentsTotal} agent${meta.agentsTotal === 1 ? '' : 's'} (${parts.join(', ')})`;
}

export class Notifier implements RunEndListener {
  private sessions = new Map<string, Session>();
  private outbox: Record<string, Notice[]>;
  private readonly path: string;
  private flushing = new Set<string>();
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private retryDelay = new Map<string, number>();

  constructor(private readonly cfg: Config, private readonly store: RunStore) {
    this.path = join(cfg.dataDir, 'outbox.json');
    this.outbox = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
  }

  private persist(): void {
    writeFileSync(this.path + '.tmp', JSON.stringify(this.outbox, null, 2));
    renameSync(this.path + '.tmp', this.path);
  }

  attach(session: Session): void {
    this.sessions.get(session.caller.name)?.close();
    this.sessions.set(session.caller.name, session);
  }

  detach(session: Session): void {
    if (this.sessions.get(session.caller.name) === session) this.sessions.delete(session.caller.name);
  }

  isConnected(caller: string): boolean {
    return this.sessions.has(caller);
  }

  pending(caller: string): number {
    return this.outbox[caller]?.length ?? 0;
  }

  runUrl(runId: string): string | null {
    return this.cfg.publicUrl ? `${this.cfg.publicUrl.replace(/\/$/, '')}/runs/${runId}` : null;
  }

  compose(meta: RunMeta): string {
    const title = `Run ${meta.id}${meta.label ? ` "${meta.label}"` : ''}`;
    const took = meta.endedAt ? fmtDuration(Date.parse(meta.endedAt) - Date.parse(meta.createdAt)) : '?';
    const head = `[swarmbase] ${title} ${meta.status} — ${countsLine(meta)} · $${meta.spentUsd.toFixed(2)} of $${meta.budgetUsd.toFixed(2)} · ${took}`;
    const lines = [head];
    if (meta.error) lines.push(`Error: ${meta.error}`);
    const resultText = this.store.readResultText(meta.id);
    if (resultText !== null) {
      const cap = this.cfg.previewChars;
      if (resultText.length <= cap) {
        lines.push('Result:', resultText);
      } else {
        lines.push(`Result preview (first ${cap} of ${resultText.length} chars — full text via the swarmbase result tool, runId "${meta.id}"):`, resultText.slice(0, cap) + '…');
      }
    }
    if (meta.status === 'interrupted' || meta.status === 'failed' || meta.status === 'cancelled') {
      if (meta.counts.ok > 0) lines.push(`${meta.counts.ok} finished agent result(s) are cached — the swarmbase resume tool re-runs the script and replays them for free.`);
    }
    const url = this.runUrl(meta.id);
    if (url) lines.push(`Dashboard: ${url}`);
    return lines.join('\n');
  }

  runEnded(meta: RunMeta): void {
    this.enqueue(meta.caller, { eventId: `${meta.id}:end`, runId: meta.id, text: this.compose(meta), createdAt: new Date().toISOString() });
  }

  enqueue(caller: string, notice: Notice): void {
    const q = (this.outbox[caller] ??= []);
    if (!q.some((n) => n.eventId === notice.eventId)) q.push(notice);
    if (q.length > OUTBOX_CAP) q.splice(0, q.length - OUTBOX_CAP);
    this.persist();
    void this.flush(caller);
  }

  async flush(caller: string): Promise<void> {
    if (this.flushing.has(caller)) return;
    const session = this.sessions.get(caller);
    if (!session || session.pushBlockedReason()) return;
    this.flushing.add(caller);
    let failed = false;
    try {
      for (;;) {
        const q = this.outbox[caller];
        if (!q || q.length === 0) break;
        const notice = q[0];
        const ok = await session.push(notice.eventId, notice.text, { kind: 'run-end', runId: notice.runId });
        if (!ok) { failed = true; break; }
        // Remove by id: enqueue() may have trimmed the queue while we awaited.
        const cur = this.outbox[caller] ?? [];
        const i = cur.findIndex((n) => n.eventId === notice.eventId);
        if (i >= 0) cur.splice(i, 1);
        if (cur.length === 0) delete this.outbox[caller];
        this.persist();
      }
    } finally {
      this.flushing.delete(caller);
    }
    if (failed) this.scheduleRetry(caller);
    else this.clearRetry(caller);
  }

  /** A failed push (host busy, timeout, refusal) retries with backoff while the session lives. */
  private scheduleRetry(caller: string): void {
    if (this.retryTimers.has(caller)) return;
    const delay = Math.min((this.retryDelay.get(caller) ?? 15_000) * 2, 10 * 60_000);
    this.retryDelay.set(caller, delay);
    const timer = setTimeout(() => {
      this.retryTimers.delete(caller);
      void this.flush(caller);
    }, delay);
    timer.unref();
    this.retryTimers.set(caller, timer);
  }

  private clearRetry(caller: string): void {
    const t = this.retryTimers.get(caller);
    if (t) clearTimeout(t);
    this.retryTimers.delete(caller);
    this.retryDelay.delete(caller);
  }
}
