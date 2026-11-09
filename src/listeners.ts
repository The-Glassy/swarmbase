import type { RequestListener } from 'node:http';
import { requestUrl } from './dashboard.js';

/** With a private dashboard socket, TCP serves only health and MCPL upgrades. */
export const mcplHttp: RequestListener = (req, res) => {
  if (req.method === 'GET' && requestUrl(req)?.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end('# HELP swarmbase_up Daemon HTTP listener is serving.\n# TYPE swarmbase_up gauge\nswarmbase_up 1\n');
  } else if (req.method === 'GET' && requestUrl(req)?.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
  } else res.writeHead(404).end('not found\n');
};
