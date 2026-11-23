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
export function adminHttp(runs: RunManager): RequestListener {
  return (req, res) => {
    if (req.method === 'POST' && req.url === '/api/drain') runs.draining = true;
    else if (req.method === 'DELETE' && req.url === '/api/drain') runs.draining = false;
    else if (req.method !== 'GET' || req.url !== '/api/health') {
      res.writeHead(404).end('not found\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...runs.stats() }));
  };
}
