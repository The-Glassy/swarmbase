// Minimal MCPL host for testing: node test/client.mjs <caller> <tool> '<json args>' [--wait]
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { McplConnection } from '@animalabs/mcpl-core';
const [caller, tool, argJson = '{}', ...flags] = process.argv.slice(2);
const token = readFileSync(`${homedir()}/.swarmbase/mcpl-${caller}.token`, 'utf8').trim();
const port = process.env.SB_PORT ?? '7360';
const ws = new WebSocket(`ws://127.0.0.1:${port}/mcpl?token=${token}`);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
const conn = McplConnection.fromWebSocket(ws);
const init = await conn.sendRequest('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, clientInfo: { name: 'sb-test', version: '0' } });
console.error('init:', JSON.stringify(init.capabilities.experimental.mcpl.featureSets.map(f => f.name)));
conn.sendNotification('notifications/initialized');
const receipt = await conn.sendRequest('featureSets/update', { effectiveCapabilities: ['tools', 'pushEvents'], enabled: ['swarmbase', 'swarmbase.notify'] });
console.error('receipt:', JSON.stringify(receipt));
if (tool !== 'none') {
  const r = await conn.sendRequest('tools/call', { name: tool, arguments: JSON.parse(argJson) }, 60000);
  console.log(r.content.map(c => c.text).join('\n') + (r.isError ? '\n[isError]' : ''));
}
if (flags.includes('--wait')) {
  const deadline = Date.now() + Number(process.env.SB_WAIT_MS ?? 600000);
  while (Date.now() < deadline) {
    const msg = await Promise.race([conn.nextMessage(), new Promise(r => setTimeout(() => r(null), deadline - Date.now()))]);
    if (!msg) break;
    if (msg.type === 'request' && msg.request.method === 'push/event') {
      console.log('\n=== push/event', msg.request.params.eventId, JSON.stringify(msg.request.params.origin));
      console.log(msg.request.params.payload.content[0].text);
      conn.sendResponse(msg.request.id, { accepted: true });
      if (!flags.includes('--keep')) break;
    }
  }
}
ws.close(); process.exit(0);
