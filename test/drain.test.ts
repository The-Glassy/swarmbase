import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { McplConnection } from '@animalabs/mcpl-core';
import { WebSocket } from 'ws';
import type { ToolResult } from '../src/session.js';

test('the private drain closes existing MCPL sessions to run and resume, and resets on restart', { timeout: 15_000 }, async () => {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const dir = mkdtempSync(join(tmpdir(), 'sb-drain-'));
  const dashboardSocket = join(dir, 'dashboard.sock');
  const adminSocket = `${dashboardSocket}.admin`;
  const configPath = join(dir, 'config.json');
  const apiKeyFile = join(dir, 'key');
  const token = 'test-drain-token';
  writeFileSync(apiKeyFile, 'unused', { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ port, dataDir: dir, dashboardSocket,
    callers: [{ name: 'test', tokenSha256: createHash('sha256').update(token).digest('hex'), apiKeyFile }] }));

  function http(path: string, socketPath?: string, method = 'GET'): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ path, socketPath, method, hostname: '127.0.0.1', port, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.setTimeout(2000, () => req.destroy(new Error(`Timed out requesting ${path}`)));
      req.once('error', reject);
      req.end();
    });
  }

  async function withDaemon(check: (conn: McplConnection) => Promise<void>) {
    const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
      env: { ...process.env, SWARMBASE_CONFIG: configPath }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    const exited = once(daemon, 'exit');
    let ws: WebSocket | undefined;
    try {
      let logs = '';
      for await (const chunk of daemon.stderr.iterator({ destroyOnReturn: false })) {
        logs += chunk;
        if (logs.includes('listening on')) break;
      }
      assert.match(logs, /listening on/);
      daemon.stderr.resume();
      ws = new WebSocket(`ws://127.0.0.1:${port}/mcpl?token=${token}`);
      await once(ws, 'open');
      const conn = McplConnection.fromWebSocket(ws as never);
      await conn.sendRequest('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'drain-test', version: '0' } }, 2000);
      await check(conn);
    } finally {
      ws?.terminate();
      daemon.kill();
      await exited;
    }
  }

  const call = async (conn: McplConnection, name: string, args: object) =>
    await conn.sendRequest('tools/call', { name, arguments: args }, 2000) as ToolResult;
  const health = async () => JSON.parse((await http('/api/health', dashboardSocket)).body);

  try {
    let runId = '';
    await withDaemon(async (conn) => {
      const started = await call(conn, 'run', { script: 'await new Promise(() => {});' });
      runId = started.content[0].text.match(/Started run (\S+)/)?.[1] ?? '';
      assert.ok(runId, started.content[0].text);
      assert.deepEqual(await health(), { ok: true, draining: false, activeRuns: 1, agentsRunning: 0, agentsQueued: 0 });
      assert.equal(statSync(adminSocket).mode & 0o777, 0o600);
      for (const socket of [undefined, dashboardSocket]) assert.notEqual((await http('/api/drain', socket, 'POST')).status, 200);
      assert.equal((await http('/api/drain', adminSocket, 'POST')).status, 200);
      assert.equal((await health()).draining, true);
      assert.equal((await call(conn, 'cancel', { runId })).isError, undefined);
      for (let i = 0; i < 100 && (await health()).activeRuns; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await health()).activeRuns, 0);
      for (const [name, args] of [['run', { script: 'return 1;' }], ['resume', { runId }]] as const) {
        const result = await call(conn, name, args);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /draining.*retry after maintenance/i);
      }
      assert.equal((await health()).activeRuns, 0);
      assert.equal(JSON.parse((await http('/api/drain', adminSocket, 'DELETE')).body).draining, false);
      assert.equal((await http('/api/drain', adminSocket, 'POST')).status, 200);
    });
    await withDaemon(async (conn) => {
      assert.equal((await health()).draining, false);
      const resumed = await call(conn, 'resume', { runId, script: 'return 1;' });
      assert.equal(resumed.isError, undefined, resumed.content[0].text);
      assert.match(resumed.content[0].text, /Started run/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
