#!/usr/bin/env node
/**
 * SwarmBase daemon — workflow orchestration for Connectome residents, as an MCPL server.
 *
 *   ws://127.0.0.1:<port>/mcpl?token=<caller token>   MCPL (one session per caller)
 *   http://127.0.0.1:<port>/                            dashboard (tailscale serve → tailnet)
 *
 * Config: ~/.swarmbase/config.json (SWARMBASE_CONFIG overrides).
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { createDashboard } from './dashboard.js';
import { addPrices, ensureEmptyMcpConfig, initLiveGroups } from './engines/claude.js';
import { bwrapAvailable } from './engines/codex.js';
import { UsageMeter } from './meter.js';
import { join } from 'node:path';
import { Notifier } from './notifier.js';
import { RunManager } from './runs.js';
import { Session } from './session.js';
import { RunStore } from './store.js';
import { SwarmTools } from './tools.js';

function log(line: string): void {
  console.error(`${new Date().toISOString()} [swarmbase] ${line}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  addPrices(cfg.prices);
  initLiveGroups(join(cfg.dataDir, 'live-agents.json'), log); // reap a crashed predecessor's agents
  const store = new RunStore(cfg.dataDir);
  const notifier = new Notifier(cfg, store);
  let meter: UsageMeter | null = null;
  if (cfg.engines.codex.baseUrl) {
    if (cfg.engines.codex.sandbox === 'bwrap' && !bwrapAvailable()) {
      throw new Error('engines.codex.sandbox is "bwrap" but bubblewrap (bwrap) is not on PATH: install it, or set sandbox to "none" (the CLI\'s own deny-list only)');
    }
    meter = new UsageMeter();
    await meter.start();
    log(`codex engine on (${cfg.engines.codex.sandbox === 'bwrap' ? 'bubblewrap wrapper' : 'NO OS wrapper: the CLI deny-list is the only read barrier; codex shells go to write-trusted callers only'})`);
  }
  const runs = new RunManager(cfg, store, ensureEmptyMcpConfig(cfg.dataDir), notifier, meter);
  for (const meta of runs.markOrphansInterrupted()) {
    log(`run ${meta.id} (${meta.caller}) was in flight at last shutdown → interrupted`);
    notifier.runEnded(meta);
  }
  if (cfg.deleteWorkOnEnd) {
    const swept = store.sweepWork();
    if (swept.length) log(`deleted the work dirs of ${swept.length} ended run(s) left behind (${swept.map((m) => m.id).join(', ')})`);
  }
  const tools = new SwarmTools(cfg, store, runs, notifier);
  const byHash = new Map(cfg.callers.map((c) => [c.tokenSha256, c]));

  const http = createServer(createDashboard(cfg, store, runs, notifier));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/mcpl') { socket.destroy(); return; }
    const token = url.searchParams.get('token') ?? '';
    const caller = token ? byHash.get(createHash('sha256').update(token).digest('hex')) : undefined;
    if (!caller) {
      log(`rejected MCPL connection (bad token) from ${req.socket.remoteAddress}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new Session(caller, ws, tools, {
        ready: (s) => { void notifier.flush(s.caller.name); },
        closed: (s) => { notifier.detach(s); log(`${s.caller.name} disconnected`); },
      }, log);
      notifier.attach(session);
      log(`${caller.name} connected (${notifier.pending(caller.name)} notice(s) waiting)`);
      void session.serve();
    });
  });

  await new Promise<void>((resolve) => http.listen(cfg.port, cfg.host, resolve));
  log(`listening on http://${cfg.host}:${cfg.port} (MCPL at /mcpl; ${cfg.callers.length} caller(s): ${cfg.callers.map((c) => c.name).join(', ')})`);

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping agents; in-flight runs will be marked interrupted on next start`);
    runs.shutdown();
    void meter?.stop();
    for (const c of wss.clients) c.terminate();
    http.close();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  // Never die with paid agents still running: stop them, then exit (launchd restarts us,
  // and the boot marks the runs interrupted so callers can resume).
  process.on('uncaughtException', (e) => {
    log(`uncaught exception: ${(e as Error).stack ?? e}`);
    try { runs.shutdown(); } finally { process.exit(1); }
  });
  process.on('unhandledRejection', (e) => {
    log(`unhandled rejection (continuing): ${(e as Error)?.stack ?? e}`);
  });
}

main().catch((e) => {
  console.error('[swarmbase] fatal:', e);
  process.exit(1);
});
