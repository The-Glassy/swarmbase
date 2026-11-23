import type { RequestListener } from 'node:http';
import { requestUrl } from './dashboard.js';
import type { RunManager } from './runs.js';

/** With a private dashboard socket, TCP serves only health and MCPL upgrades. */
export const mcplHttp: RequestListener = (req, res) => {
  if (req.method === 'GET' && requestUrl(req)?.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end('# HELP swarmbase_up Daemon HTTP listener is serving.\n# TYPE swarmbase_up gauge\nswarmbase_up 1\n');
  } else if (req.method === 'GET' && requestUrl(req)?.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
  } else res.writeHead(404).end('not found\n');
};

/** Only served on the owner-only admin socket. The dashboard proxy cannot reach it. */
export function adminHttp(runs: RunManager, log: (line: string) => void): RequestListener {
  return (req, res) => {
    const url = requestUrl(req);
    if (req.method === 'POST' && url?.pathname === '/api/drain') {
      const ttlMs = url.searchParams.get('ttlMs');
      if (!runs.startDrain(() => log('Maintenance drain expired; run and resume admission reopened.'), ttlMs === null ? undefined : Number(ttlMs))) {
        res.writeHead(400).end('ttlMs must be a positive integer no greater than 2147483647\n');
        return;
      }
    } else if (req.method === 'DELETE' && req.url === '/api/drain') {
      runs.releaseDrain();
    } else if (req.method !== 'GET' || req.url !== '/api/health') {
      res.writeHead(404).end('not found\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...runs.stats() }));
  };
}
