// Being on the tailnet is not enough to read a run: the dashboard answers only logins on
// its access lists (deny by default), and re-reads those lists when the config file changes.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parseConfig, watchDashboardAccess, type DashboardAccess } from '../src/config.js';
import { createDashboard } from '../src/dashboard.js';
import type { Notifier } from '../src/notifier.js';
import type { RunManager } from '../src/runs.js';
import { RunStore } from '../src/store.js';

const ADMIN = 'admin@example.com';
const VIEWER = 'viewer@example.com';
const STRANGER = 'stranger@example.com';
const SECRET_SCRIPT = 'return "a prompt nobody else should read"';

const dataDir = mkdtempSync(join(tmpdir(), 'swarmbase-dashboard-'));
const cfg = parseConfig({ dataDir, dashboard: { viewerLogins: [VIEWER], adminLogins: [ADMIN] } as DashboardAccess });
const store = new RunStore(dataDir);
const meta = store.create({
  caller: 'nestor', label: 'private run', script: SECRET_SCRIPT, args: null, defaults: {}, budgetUsd: 1, budgetTokens: 0, resumedFrom: null,
});
const cancelled: string[] = [];
const runs = {
  stats: () => ({ activeRuns: 0, agentsRunning: 0, agentsQueued: 0 }),
  isActive: () => false,
  cancel: (id: string) => { cancelled.push(id); return true; },
  skipAgent: () => true,
} as unknown as RunManager;
const notifier = { isConnected: () => false } as unknown as Notifier;

let access: DashboardAccess = cfg.dashboard;
const server = createServer(createDashboard(cfg, store, runs, notifier, () => access));
let port = 0;

before(async () => {
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function call(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // The dashboard's Host allowlist is built from cfg.port; the test server listens elsewhere.
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${cfg.port}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    // An event stream that should have been refused would otherwise hang the suite, not fail it.
    req.setTimeout(5000, () => req.destroy(new Error(`${method} ${path}: no complete response within 5 s`)));
    req.on('error', reject);
    req.end();
  });
}
const as = (login: string) => ({ 'tailscale-user-login': login });

const CONTENT_ROUTES = () => [
  '/',
  `/runs/${meta.id}`,
  '/static/common.js',
  '/api/runs',
  `/api/runs/${meta.id}`,
  `/api/runs/${meta.id}/events`,
  `/api/runs/${meta.id}/result`,
  `/api/runs/${meta.id}/agents/1`,
];

test('every content route refuses a request with no identity', async () => {
  for (const path of CONTENT_ROUTES()) {
    const r = await call(path);
    assert.equal(r.status, 403, path);
    assert.ok(!r.body.includes(SECRET_SCRIPT), path);
  }
});

test('every content route refuses a tailnet login on neither list', async () => {
  for (const path of CONTENT_ROUTES()) {
    const r = await call(path, as(STRANGER));
    assert.equal(r.status, 403, path);
    assert.ok(!r.body.includes(SECRET_SCRIPT), path);
  }
});

test('viewers and admins can read a run', async () => {
  for (const login of [VIEWER, ADMIN]) {
    const r = await call(`/api/runs/${meta.id}`, as(login));
    assert.equal(r.status, 200, login);
    assert.ok(r.body.includes('a prompt nobody else should read'), login);
  }
});

test('logins compare without regard to case, on either side', async () => {
  assert.equal((await call('/api/runs', as('Viewer@Example.COM'))).status, 200);
  assert.deepEqual(parseConfig({ dashboard: { viewerLogins: [' Mixed@Example.COM '], adminLogins: [] } }).dashboard.viewerLogins, ['mixed@example.com']);
});

test('a login close to a listed one is not on the list', async () => {
  for (const near of ['aviewer@example.com', 'viewer@example.com.evil.test', 'viewer@example.co', 'viewer', '@example.com']) {
    assert.equal((await call('/api/runs', as(near))).status, 403, near);
  }
});

test('a request target the URL parser refuses is a 400, and the daemon survives it', async () => {
  for (const target of ['//', '//[', '//@']) {
    assert.equal((await call(target)).status, 400, target);
  }
  assert.equal((await call('/api/health')).status, 200);
});

test('a viewer taken off the lists loses an event stream already open', async () => {
  const before = 'sent while still on the list';
  const removed = 'sent after removal';
  let body = '';
  const ended = new Promise<void>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: `/api/runs/${meta.id}/events`, headers: { host: `127.0.0.1:${cfg.port}`, ...as(VIEWER) } },
      (res) => {
        assert.equal(res.statusCode, 200);
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', resolve);
        res.once('data', () => {
          store.emit(meta.id, { type: 'log', message: before });
          access = { viewerLogins: [], adminLogins: [ADMIN] };
          store.emit(meta.id, { type: 'log', message: removed });
        });
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error('the stream stayed open after removal')));
    req.on('error', reject);
    req.end();
  });
  try {
    await ended;
  } finally {
    access = cfg.dashboard;
  }
  assert.ok(body.includes(before), 'the stream was delivering before the removal');
  assert.ok(!body.includes(removed), 'nothing is delivered after the removal');
});

test('Funnel traffic has no identity, whatever login it presents', async () => {
  const r = await call('/api/runs', { ...as(ADMIN), 'tailscale-funnel-request': '?1' });
  assert.equal(r.status, 403);
});

test('only health and whoami answer anyone, and they carry no run content', async () => {
  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true, activeRuns: 0, agentsRunning: 0, agentsQueued: 0 });

  assert.deepEqual(JSON.parse((await call('/api/whoami')).body), { login: null, viewer: false, admin: false });
  assert.deepEqual(JSON.parse((await call('/api/whoami', as(STRANGER))).body), { login: STRANGER, viewer: false, admin: false });
  assert.deepEqual(JSON.parse((await call('/api/whoami', as(VIEWER))).body), { login: VIEWER, viewer: true, admin: false });
  assert.deepEqual(JSON.parse((await call('/api/whoami', as(ADMIN))).body), { login: ADMIN, viewer: true, admin: true });
});

test('cancel needs an admin: a viewer may read but not act', async () => {
  const headers = { 'x-swarmbase': '1' };
  const path = `/api/runs/${meta.id}/cancel`;
  assert.equal((await call(path, { ...headers }, 'POST')).status, 403);
  assert.equal((await call(path, { ...headers, ...as(STRANGER) }, 'POST')).status, 403);
  assert.equal((await call(path, { ...headers, ...as(VIEWER) }, 'POST')).status, 403);
  assert.deepEqual(cancelled, []);

  assert.equal((await call(path, { ...headers, ...as(ADMIN) }, 'POST')).status, 200);
  assert.deepEqual(cancelled, [meta.id]);
});

test('a config with no lists denies everyone', async () => {
  assert.deepEqual(parseConfig({}).dashboard, { viewerLogins: [], adminLogins: [] });
  const saved = access;
  access = parseConfig({}).dashboard;
  try {
    assert.equal((await call('/api/runs', as(ADMIN))).status, 403);
  } finally {
    access = saved;
  }
});

test('a malformed list refuses the config instead of opening the dashboard', () => {
  assert.throws(() => parseConfig({ dashboard: { viewerLogins: 'everyone@example.com' } as unknown as DashboardAccess }), /viewerLogins/);
  assert.throws(() => parseConfig({ dashboard: { adminLogins: [''] } as unknown as DashboardAccess }), /adminLogins/);
});

test('list changes apply without a restart, and a bad edit keeps the last good lists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarmbase-access-'));
  try {
    const path = join(dir, 'config.json');
    const write = (text: string, atMs: number) => {
      writeFileSync(path, text);
      utimesSync(path, atMs / 1000, atMs / 1000); // an mtime the watcher can't miss on a coarse clock
    };
    const t0 = 1_800_000_000_000;
    write(JSON.stringify({ dashboard: { viewerLogins: [VIEWER], adminLogins: [ADMIN] } }), t0);
    const logs: string[] = [];
    const get = watchDashboardAccess(path, { viewerLogins: [VIEWER], adminLogins: [ADMIN] }, (l) => logs.push(l));
    assert.deepEqual(get().viewerLogins, [VIEWER]);

    write(JSON.stringify({ dashboard: { viewerLogins: [], adminLogins: [ADMIN] } }), t0 + 5000);
    assert.deepEqual(get().viewerLogins, [], 'a removed viewer loses access');

    write('{ not json', t0 + 10_000);
    assert.deepEqual(get(), { viewerLogins: [], adminLogins: [ADMIN] }, 'a broken file changes nothing');
    assert.ok(logs.some((l) => l.includes('reload failed')));

    write(JSON.stringify({ dashboard: { viewerLogins: 'nope' } }), t0 + 15_000);
    assert.deepEqual(get(), { viewerLogins: [], adminLogins: [ADMIN] }, 'a malformed list changes nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
