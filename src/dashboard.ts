/**
 * Dashboard HTTP API + static pages. Bound to 127.0.0.1 and published on the
 * tailnet with `tailscale serve --https=<port>` (never Funnel). Viewing is
 * open to the tailnet; cancel/skip need a Tailscale-User-Login listed in
 * config.dashboard.adminLogins AND an `X-SwarmBase: 1` header (a custom header
 * forces a CORS preflight we never answer, so other sites can't CSRF it).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { Notifier } from './notifier.js';
import type { RunManager } from './runs.js';
import type { RunStore } from './store.js';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../public');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function login(req: IncomingMessage): string | null {
  const v = req.headers['tailscale-user-login'];
  return typeof v === 'string' && v ? v : null;
}

function clip(s: unknown, n: number): string {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  return t.length > n ? t.slice(0, n) + `… [${t.length - n} more chars]` : t;
}

/** Raw engine stream lines (Claude Code stream-json or Codex exec JSONL) → a compact, renderable transcript. */
export function normalizeTranscript(raw: string): unknown[] {
  const items: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, any>;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'thread.started') {
      items.push({ kind: 'init', model: '', tools: [], cwd: '', engine: 'codex' });
    } else if (typeof e.type === 'string' && e.type.startsWith('item.') && e.item) {
      const it = e.item as Record<string, any>;
      if (e.type !== 'item.completed') continue;
      if (it.type === 'agent_message') items.push({ kind: 'text', text: clip(it.text ?? '', 20_000) });
      else if (it.type === 'reasoning') items.push({ kind: 'thinking', text: clip(it.text ?? '', 8_000) });
      else if (it.type === 'command_execution') {
        items.push({ kind: 'tool_use', name: 'shell', input: clip(it.command ?? '', 6_000) });
        items.push({ kind: 'tool_result', text: clip(it.aggregated_output ?? '', 6_000), isError: !!it.exit_code });
      } else if (it.type === 'error') items.push({ kind: 'tool_result', text: clip(it.message ?? '', 2_000), isError: true });
      else items.push({ kind: 'tool_use', name: String(it.type), input: clip(it, 6_000) });
    } else if (e.type === 'turn.completed') {
      items.push({ kind: 'result', subtype: 'success', usage: e.usage });
    } else if (e.type === 'turn.failed' || e.type === 'error') {
      items.push({ kind: 'result', subtype: 'error', usage: null, error: e.error?.message ?? e.message });
    } else if (e.type === 'system' && e.subtype === 'init') {
      items.push({ kind: 'init', model: e.model, tools: e.tools, cwd: e.cwd });
    } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type === 'text') items.push({ kind: 'text', text: clip(b.text, 20_000) });
        else if (b.type === 'thinking') items.push({ kind: 'thinking', text: clip(b.thinking ?? '', 8_000) });
        else if (b.type === 'tool_use') items.push({ kind: 'tool_use', name: b.name, input: clip(b.input, 6_000) });
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === 'tool_result') {
          const content = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? b.content.map((c: any) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join('\n') : '';
          items.push({ kind: 'tool_result', text: clip(content, 6_000), isError: !!b.is_error });
        }
      }
    } else if (e.type === 'result') {
      items.push({ kind: 'result', subtype: e.subtype, costUsd: e.total_cost_usd, turns: e.num_turns, durationMs: e.duration_ms, usage: e.usage });
    }
  }
  return items;
}

export function createDashboard(cfg: Config, store: RunStore, runs: RunManager, notifier: Notifier) {
  const isAdmin = (req: IncomingMessage): boolean => {
    const who = login(req);
    return !!who && cfg.dashboard.adminLogins.includes(who);
  };

  const serveStatic = (res: ServerResponse, file: string): void => {
    const p = resolve(PUBLIC_DIR, file);
    if (!(p === PUBLIC_DIR || p.startsWith(PUBLIC_DIR + sep)) || !existsSync(p)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(p));
  };

  const sse = (req: IncomingMessage, res: ServerResponse, runId: string, since: number): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': hello\n\n');
    let last = since;
    const write = (e: { seq: number }) => {
      if (e.seq <= last) return;
      last = e.seq;
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const unsubscribe = store.subscribe(runId, write); // subscribe first, then backfill: no gap
    for (const e of store.readEvents(runId, since)) write(e);
    const ka = setInterval(() => res.write(': ka\n\n'), 20_000);
    req.on('close', () => { clearInterval(ka); unsubscribe(); });
  };

  // DNS-rebinding guard: only our own names may address this server.
  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
  if (cfg.publicUrl) {
    const u = new URL(cfg.publicUrl);
    allowedHosts.add(u.host);
    allowedHosts.add(u.hostname);
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!allowedHosts.has(String(req.headers.host ?? ''))) { res.writeHead(421).end('misdirected request'); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET') {
        if (parts.length === 0) return serveStatic(res, 'index.html');
        if (parts[0] === 'runs' && parts.length === 2) return serveStatic(res, 'run.html');
        if (parts[0] === 'static' && parts.length === 2) return serveStatic(res, parts[1]);
        if (parts[0] === 'api') {
          if (parts[1] === 'whoami') return json(res, 200, { login: login(req), admin: isAdmin(req) });
          if (parts[1] === 'health') return json(res, 200, { ok: true, ...runs.stats() });
          if (parts[1] === 'runs' && parts.length === 2) {
            return json(res, 200, {
              stats: runs.stats(),
              runs: store.list().slice(0, Number(url.searchParams.get('limit') ?? 200)).map((m) => ({ ...m, dir: undefined, live: runs.isActive(m.id) })),
            });
          }
          if (parts[1] === 'runs' && parts.length >= 3) {
            const id = parts[2];
            const meta = store.get(id);
            if (!meta) return json(res, 404, { error: 'no such run' });
            if (parts.length === 3) {
              return json(res, 200, {
                meta: { ...meta, dir: undefined },
                live: runs.isActive(id),
                callerConnected: notifier.isConnected(meta.caller),
                script: store.readScript(id),
                args: store.readArgs(id),
                events: store.readEvents(id),
              });
            }
            if (parts[3] === 'events') return sse(req, res, id, Number(url.searchParams.get('since') ?? 0) || 0);
            if (parts[3] === 'result') {
              const t = store.readResultText(id);
              return t === null ? json(res, 404, { error: 'no result' }) : json(res, 200, { text: t });
            }
            if (parts[3] === 'agents' && parts[4]) {
              const n = Number(parts[4]);
              const raw = store.readAgentFile(id, n, '.jsonl');
              const prompt = store.readAgentFile(id, n, '.prompt.txt');
              const schema = store.readAgentFile(id, n, '.schema.json');
              if (raw === null && prompt === null) return json(res, 404, { error: 'no such agent' });
              return json(res, 200, { n, prompt, schema: schema ? JSON.parse(schema) : null, transcript: normalizeTranscript(raw ?? '') });
            }
          }
        }
        return json(res, 404, { error: 'not found' });
      }

      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'runs' && parts[2]) {
        if (req.headers['x-swarmbase'] !== '1') return json(res, 400, { error: 'missing X-SwarmBase header' });
        if (!isAdmin(req)) return json(res, 403, { error: `not an admin (${login(req) ?? 'no tailnet identity'})` });
        const id = parts[2];
        const who = login(req)!;
        if (parts[3] === 'cancel') return json(res, 200, { ok: runs.cancel(id, `${who} (dashboard)`) });
        if (parts[3] === 'agents' && parts[4] && parts[5] === 'skip') return json(res, 200, { ok: runs.skipAgent(id, Number(parts[4])) });
        return json(res, 404, { error: 'not found' });
      }
      res.writeHead(405).end('method not allowed');
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  };
}
