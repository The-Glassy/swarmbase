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
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  model: string | null;
}

export interface MeterSlot {
  /** Upstream endpoint; the request path is appended (e.g. `https://gate/codex` + `/responses`). */
  upstream: string;
  /** The real bearer, sent upstream in place of the agent's. */
  bearer: string;
  /** Extra request headers (gateway attribution). */
  headers: Record<string, string>;
  /** One call per upstream response that carried usage. */
  onUsage: (u: Usage, status: number) => void;
}

interface Live extends MeterSlot { key: string }

const MAX_CAPTURE = 8 * 1024 * 1024;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length']);

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
    this.slots.clear();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Base URL the agent's CLI points at, and the bearer it authenticates with. */
  register(slot: MeterSlot): { key: string; bearer: string; baseUrl: string } {
    if (!this.port) throw new Error('meter not started');
    const key = randomBytes(8).toString('hex');
    const bearer = `sbm_${randomBytes(32).toString('hex')}`;
    this.slots.set(bearer, { ...slot, key });
    return { key, bearer, baseUrl: `http://${this.host}:${this.port}/m` };
  }

  release(bearer: string): void {
    this.slots.delete(bearer);
  }

  get active(): number {
    return this.slots.size;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const auth = String(req.headers.authorization ?? '');
    const slot = auth.startsWith('Bearer ') ? this.slots.get(auth.slice(7).trim()) : undefined;
    const path = req.url ?? '/';
    if (!slot || !path.startsWith('/m/')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unknown meter bearer', type: 'unauthorized' } }));
      req.resume();
      return;
    }
    let target: URL;
    try { target = new URL(slot.upstream.replace(/\/+$/, '') + path.slice('/m'.length)); }
    catch { res.writeHead(502).end(); req.resume(); return; }

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || k.startsWith('x-gate-')) continue;
      headers[k] = v;
    }
    headers.authorization = `Bearer ${slot.bearer}`;
    headers.host = target.host;
    for (const [k, v] of Object.entries(slot.headers)) headers[k] = v;
    if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length'];

    const lib = target.protocol === 'https:' ? https : http;
    const up = lib.request(target, { method: req.method, headers }, (ur) => {
      const status = ur.statusCode ?? 502;
      res.writeHead(status, ur.headers);
      let captured = '';
      let overflow = false;
      ur.on('data', (chunk: Buffer) => {
        if (!overflow) {
          captured += chunk.toString('utf8');
          if (captured.length > MAX_CAPTURE) overflow = true;
        }
        res.write(chunk);
      });
      ur.on('end', () => {
        res.end();
        if (overflow) return;
        const u = parseUsage(captured, String(ur.headers['content-type'] ?? ''));
        if (u) { try { slot.onUsage(u, status); } catch { /* the engine's problem */ } }
      });
      ur.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
    });
    up.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `meter: upstream ${e.message}`, type: 'bad_gateway' } }));
      } else {
        try { res.destroy(); } catch { /* gone */ }
      }
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  }
}

/** Usage out of a Responses-API body: the terminal `response.completed` event of
 *  an SSE stream (the ChatGPT backend sends no content-type on streams, so the
 *  body is sniffed), else a JSON response object. */
export function parseUsage(body: string, contentType: string): Usage | null {
  const trimmed = body.trimStart();
  const sse = contentType.includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.startsWith('data:') || trimmed.startsWith(':');
  let response: Record<string, any> | null = null;
  if (sse) {
    for (const block of body.split(/\n\n/)) {
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      let e: Record<string, any>;
      try { e = JSON.parse(data); } catch { continue; }
      if (e.type === 'response.completed' || e.type === 'response.incomplete' || e.type === 'response.failed') {
        if (e.response?.usage) response = e.response;
      }
    }
  } else {
    try { const j = JSON.parse(body); if (j && typeof j === 'object' && j.usage) response = j; } catch { /* not JSON */ }
  }
  const u = response?.usage;
  if (!u) return null;
  return {
    inputTokens: Number(u.input_tokens ?? 0),
    cachedInputTokens: Number(u.input_tokens_details?.cached_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    model: typeof response?.model === 'string' ? response.model : null,
  };
}
