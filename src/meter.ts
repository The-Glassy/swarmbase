/**
 * UsageMeter — a loopback Responses-API relay that sits between a subagent CLI
 * and the inference endpoint, for engines whose CLI reports token usage only
 * when a turn ends (Codex: `exec --json` carries usage in `turn.completed`,
 * and an exec run is one turn). Each registered agent gets its own bearer; the
 * relay swaps it for the caller's real token, adds the gateway attribution
 * headers, and reads the usage out of every response as it streams past — so
 * the daemon can price the agent as it goes and stop it when it crosses its
 * ceiling, and so the subagent process never holds the caller's token.
 *
 * Bound to 127.0.0.1 only. A bearer is 32 random bytes and dies with the agent.
 * The relay serves exactly one route, `POST /m/responses`: a meter bearer is
 * worth nothing on any other path of the gateway. Usage is parsed from the SSE
 * stream incrementally (one event in memory at a time, LF or CRLF framed), so
 * a long response is counted like a short one. Releasing a slot, or the CLI
 * dropping its connection, destroys the in-flight upstream request, so a
 * killed agent stops costing when it is killed; the usage of that cut-off
 * response is unknown and goes unrecorded (bounded by one response).
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { Transform, pipeline } from 'node:stream';

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  model: string | null;
}

export interface MeterSlot {
  /** Upstream endpoint; `/responses` is appended (e.g. `https://gate/codex`). */
  upstream: string;
  /** The real bearer, sent upstream in place of the agent's. */
  bearer: string;
  /** Extra request headers (gateway attribution). */
  headers: Record<string, string>;
  /** One call per upstream response that carried usage. */
  onUsage: (u: Usage, status: number) => void;
}

interface Live extends MeterSlot { key: string; inflight: Set<http.ClientRequest> }

/** The route the CLI needs; everything else is 404. */
const ROUTE = { method: 'POST', path: '/m/responses' };
/** One SSE event's `data` (or one non-streamed JSON body) is kept at most this long. */
const MAX_EVENT = 4 * 1024 * 1024;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'host', 'content-length']);

export class UsageMeter {
  private readonly server: http.Server;
  private readonly slots = new Map<string, Live>();
  private port = 0;

  constructor(private readonly host = '127.0.0.1') {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.keepAliveTimeout = 65_000;
  }

  async start(): Promise<void> {
    this.server.listen(0, this.host);
    await once(this.server, 'listening');
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    for (const bearer of [...this.slots.keys()]) this.release(bearer);
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Base URL the agent's CLI points at, and the bearer it authenticates with. */
  register(slot: MeterSlot): { key: string; bearer: string; baseUrl: string } {
    if (!this.port) throw new Error('meter not started');
    const key = randomBytes(8).toString('hex');
    const bearer = `sbm_${randomBytes(32).toString('hex')}`;
    this.slots.set(bearer, { ...slot, key, inflight: new Set() });
    return { key, bearer, baseUrl: `http://${this.host}:${this.port}/m` };
  }

  /** Forget the bearer and cut every request still in flight on it. */
  release(bearer: string): void {
    const live = this.slots.get(bearer);
    if (!live) return;
    this.slots.delete(bearer);
    for (const up of live.inflight) up.destroy();
    live.inflight.clear();
  }

  get active(): number {
    return this.slots.size;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const auth = String(req.headers.authorization ?? '');
    const slot = auth.startsWith('Bearer ') ? this.slots.get(auth.slice(7).trim()) : undefined;
    if (!slot) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unknown meter bearer', type: 'unauthorized' } }));
      req.resume();
      return;
    }
    if (req.method !== ROUTE.method || (req.url ?? '') !== ROUTE.path) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `meter: only ${ROUTE.method} ${ROUTE.path} is relayed`, type: 'not_found' } }));
      req.resume();
      return;
    }
    let target: URL;
    try { target = new URL(slot.upstream.replace(/\/+$/, '') + '/responses'); }
    catch { res.writeHead(502).end(); req.resume(); return; }

    const headers = relayHeaders(req.headers, (k) => k.startsWith('x-gate-'));
    headers.authorization = `Bearer ${slot.bearer}`;
    headers.host = target.host;
    for (const [k, v] of Object.entries(slot.headers)) headers[k] = v;
    if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length'];

    const lib = target.protocol === 'https:' ? https : http;
    const up = lib.request(target, { method: req.method, headers }, (ur) => {
      const status = ur.statusCode ?? 502;
      res.writeHead(status, relayHeaders(ur.headers));
      const tap = usageTap(String(ur.headers['content-type'] ?? ''), (u) => {
        try { slot.onUsage(u, status); } catch { /* the engine's problem */ }
      });
      pipeline(ur, tap, res, () => { /* either side ended or failed; nothing to add */ });
    });
    slot.inflight.add(up);
    up.on('close', () => slot.inflight.delete(up));
    up.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        const code = (e as NodeJS.ErrnoException).code ?? '';
        const hint = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME/.test(code + ' ' + e.message)
          ? ' (the endpoint\'s certificate is not in this daemon\'s trust store — a private CA needs NODE_EXTRA_CA_CERTS=<ca.pem> in the daemon\'s environment)'
          : '';
        res.end(JSON.stringify({ error: { message: `meter: upstream ${e.message}${hint}`, type: 'bad_gateway' } }));
      } else {
        try { res.destroy(); } catch { /* gone */ }
      }
    });
    // The CLI went away (killed, or gave up on the stream): stop paying upstream.
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.on('aborted', () => up.destroy());
    pipeline(req, up, () => { /* upstream errors are reported above */ });
  }
}

/** Copy headers minus hop-by-hop ones (including those the `Connection` header
 *  nominates) and whatever `drop` names. */
function relayHeaders(h: http.IncomingHttpHeaders, drop: (k: string) => boolean = () => false): Record<string, string | string[]> {
  const nominated = new Set(String(h.connection ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || HOP_BY_HOP.has(k) || nominated.has(k) || drop(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * A pass-through that watches the body for usage. SSE (by content-type, or
 * sniffed from the first bytes, since the ChatGPT backend sends streams without
 * one) is parsed one event at a time, LF or CRLF framed; a non-SSE body is
 * read as one JSON response object. `onUsage` fires once, on the terminal
 * event (`response.completed` / `.incomplete` / `.failed`) or at the end of a
 * JSON body.
 */
export function usageTap(contentType: string, onUsage: (u: Usage) => void): Transform {
  const scan = new UsageScanner(contentType);
  return new Transform({
    transform(chunk: Buffer, _enc, cb) { scan.feed(chunk.toString('utf8')); cb(null, chunk); },
    flush(cb) { const u = scan.end(); if (u) onUsage(u); cb(); },
  });
}

class UsageScanner {
  private sse: boolean | null;
  private line = '';
  private data: string[] = [];
  private dataLen = 0;
  private json = '';
  private overflow = false;
  private found: Usage | null = null;

  constructor(contentType: string) {
    this.sse = contentType.includes('text/event-stream') ? true : contentType.includes('json') ? false : null;
  }

  feed(s: string): void {
    if (this.sse === null) {
      const head = (this.line + s).trimStart();
      if (head.length) this.sse = /^(event:|data:|:|id:|retry:)/.test(head);
    }
    if (this.sse) {
      this.line += s;
      let nl: number;
      while ((nl = this.line.indexOf('\n')) >= 0) { this.feedLine(this.line.slice(0, nl)); this.line = this.line.slice(nl + 1); }
    } else if (this.json.length <= MAX_EVENT) this.json += s;
  }

  end(): Usage | null {
    if (this.sse) { if (this.line) this.feedLine(this.line); this.endEvent(); }
    else if (this.json.length <= MAX_EVENT) {
      try { this.found = usageOf(JSON.parse(this.json)) ?? this.found; } catch { /* not JSON */ }
    }
    return this.found;
  }

  private feedLine(l: string): void {
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (l === '') { this.endEvent(); return; }
    if (!l.startsWith('data:')) return;
    const d = l.slice(5).replace(/^ /, '');
    this.dataLen += d.length;
    if (this.dataLen > MAX_EVENT) { this.overflow = true; this.data = []; return; }
    this.data.push(d);
  }

  private endEvent(): void {
    if (this.data.length && !this.overflow) {
      const u = usageFromEvent(this.data.join('\n'));
      if (u) this.found = u;
    }
    this.data = []; this.dataLen = 0; this.overflow = false;
  }
}

function usageFromEvent(data: string): Usage | null {
  if (!data || data === '[DONE]') return null;
  let e: Record<string, any>;
  try { e = JSON.parse(data); } catch { return null; }
  if (e.type === 'response.completed' || e.type === 'response.incomplete' || e.type === 'response.failed') return usageOf(e.response);
  return null;
}

function usageOf(response: unknown): Usage | null {
  const r = response as Record<string, any> | null;
  const u = r?.usage;
  if (!u || typeof u !== 'object') return null;
  return {
    inputTokens: Number(u.input_tokens ?? 0),
    cachedInputTokens: Number(u.input_tokens_details?.cached_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    model: typeof r?.model === 'string' ? r.model : null,
  };
}

/** Usage out of a whole Responses-API body (tests and offline tools; the relay
 *  itself streams through `usageTap`). */
export function parseUsage(body: string, contentType: string): Usage | null {
  const scan = new UsageScanner(contentType);
  scan.feed(body);
  return scan.end();
}
