/**
 * Codex engine: config, the rendered CODEX_HOME, the meter relay, and — when a
 * Codex CLI is on this machine (CODEX_BIN, or the usual install paths) — live
 * runs against a fake Responses backend: a tool-call round trip whose command
 * tries to read a secret beside the workspace (must fail), the structured
 * output path, the think profile (no tools offered), and the token ceiling kill.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig, resolveOnPath } from '../src/config.js';
import { normalizeTranscript } from '../src/dashboard.js';
import { binMounts, bwrapArgs, bwrapAvailable, buildArgs, denyPaths, renderConfig, runCodexAgent, strictSchema, strictSchemaProblem, type CodexAgentSpec } from '../src/engines/codex.js';
import { parseUsage, UsageMeter } from '../src/meter.js';

const caller = { name: 'r', tokenSha256: 'a'.repeat(64), apiKeyFile: '/tmp/x.key' };

/** A PATH with one executable `codex` on it (a stand-in file), for config resolution. */
function fakePath(): { dir: string; bin: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-path-'));
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  return { dir, bin };
}

test('config: legacy keys map onto engines.claude; codex needs a baseUrl; per-engine defaults', () => {
  const c = parseConfig({ apiBaseUrl: 'https://g/anthropic', claudeBin: '/x/claude', callers: [{ ...caller, engines: ['claude'] }] } as any);
  assert.equal(c.engines.claude.baseUrl, 'https://g/anthropic');
  assert.equal(c.engines.claude.bin, '/x/claude');
  assert.equal(c.apiBaseUrl, 'https://g/anthropic');
  assert.equal(c.engines.codex.baseUrl, null);
  assert.equal(c.callers[0].defaultModels.claude, 'claude-sonnet-5-5');
  assert.throws(() => parseConfig({ callers: [{ ...caller, engines: ['claude', 'codex'] }] } as any), /engines\.codex\.baseUrl/);
  assert.throws(() => parseConfig({ callers: [{ ...caller, engines: ['gemini'] }] } as any), /unknown engine/);
  const p = fakePath();
  try {
    const d = parseConfig({ engines: { codex: { baseUrl: 'https://g/codex', sandbox: 'none' } }, callers: [{ ...caller, engines: ['codex'], defaultModel: 'claude-opus-5-5', defaultModels: { codex: 'gpt-x' } }] } as any, `/nonexistent:${p.dir}`);
    assert.equal(d.engines.codex.sandbox, 'none');
    assert.equal(d.engines.codex.bin, p.bin, 'a bare bin name is resolved on PATH at load');
    assert.deepEqual(d.callers[0].defaultModels, { claude: 'claude-opus-5-5', codex: 'gpt-x' });
    assert.equal(d.callers[0].defaultModel, 'claude-opus-5-5');
    assert.equal(d.callers[0].runTokensDefault, 10_000_000);
    assert.equal(d.callers[0].runTokensMax, 30_000_000);
    assert.equal(d.engines.codex.maxTokensMax, 3_000_000);
    assert.throws(() => parseConfig({ engines: { codex: { baseUrl: 'https://g/codex' } }, callers: [] } as any, '/nonexistent'), /engines\.codex\.bin "codex" was not found on PATH/);
    assert.equal(parseConfig({ engines: { codex: { baseUrl: 'https://g/codex', bin: '/opt/x/codex' } }, callers: [] } as any, '/nonexistent').engines.codex.bin, '/opt/x/codex', 'an absolute path is taken as given');
    assert.equal(parseConfig({ engines: { codex: { bin: 'codex' } }, callers: [] } as any, '/nonexistent').engines.codex.bin, 'codex', 'not resolved while the engine is off');
    assert.equal(parseConfig({ engines: { codex: { baseUrl: 'https://g/codex', maxTokensDefault: 5_000_000 } }, callers: [] } as any, p.dir).engines.codex.maxTokensMax, 5_000_000, 'the cap follows a raised default');
    assert.throws(() => parseConfig({ engines: { codex: { baseUrl: 'https://g/codex', maxTokensDefault: 100, maxTokensMax: 50 } }, callers: [] } as any, p.dir), /maxTokensMax/);
    assert.throws(() => parseConfig({ callers: [{ ...caller, runTokensMax: 0 }] } as any), /runTokensMax/);
    assert.equal(resolveOnPath('codex', `${p.dir}`), p.bin);
    assert.equal(resolveOnPath('codex', '/nonexistent'), null);
  } finally {
    fs.rmSync(p.dir, { recursive: true, force: true });
  }
  assert.throws(() => parseConfig({ engines: { codex: { baseUrl: 'x', sandbox: 'firejail' } }, callers: [] } as any), /sandbox/);
});

function spec(over: Partial<CodexAgentSpec> = {}): CodexAgentSpec {
  return {
    runId: 'r1', n: 1, label: 'a', prompt: 'hi', schema: null, model: 'gpt-test', effort: null, profile: 'read',
    cwd: '/w/work', timeoutMs: 60_000, maxBudgetUsd: 1, maxTokens: 1_000_000, streamPath: '/dev/null',
    homeDir: '/w/home', apiKey: 'gt_real', baseUrl: 'https://g/codex', codexBin: '/usr/bin/codex', sandbox: 'bwrap', extraRoBinds: [], dataDir: '/sb', denyExtra: [],
    ...over,
  };
}

test('rendered CODEX_HOME: profile selected by default_permissions, never -s; think has no tools; deny-list covers the daemon secrets', () => {
  const meter = { baseUrl: 'http://127.0.0.1:1/m', bearer: 'sbm_x' };
  const read = renderConfig(spec(), meter);
  assert.match(read, /^default_permissions = "swarm-read"$/m);
  assert.match(read, /^model_provider = "swarmbase"$/m);
  assert.match(read, /^base_url = "http:\/\/127\.0\.0\.1:1\/m"$/m);
  assert.match(read, /http_headers = \{ "authorization" = "Bearer sbm_x" \}/);
  assert.match(read, /^"\/sb\/\*\.key" = "deny"$/m);
  assert.match(read, /^"\/w\/home\/config\.toml" = "deny"$/m);
  // run records are enumerated (exact paths work on every CLI version; `*` directory components don't)
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dd-'));
  try {
    fs.mkdirSync(path.join(dd, 'runs', 'r1', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(dd, 'runs', 'r2', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dd, 'runs', 'r1', 'meta.json'), '{}');
    fs.writeFileSync(path.join(dd, 'runs', 'r2', 'result.json'), '{}');
    const got = renderConfig(spec({ dataDir: dd }), meter);
    assert.match(got, new RegExp(`^"${dd}/runs/r1/meta\\.json" = "deny"$`, 'm'));
    assert.match(got, new RegExp(`^"${dd}/runs/r2/result\\.json" = "deny"$`, 'm'));
    assert.doesNotMatch(got, new RegExp(`"${dd}/runs/r2/meta\\.json"`), 'only files that exist');
    assert.match(got, new RegExp(`^"${dd}/runs/r2/agents/\\*" = "deny"$`, 'm'));
    assert.match(got, new RegExp(`^"${dd}/runs/r2/agents/\\*\\*/config\\.toml" = "deny"$`, 'm'), 'sibling agents\' meter bearers');
    assert.match(got, /^glob_scan_max_depth = 8$/m);
  } finally { fs.rmSync(dd, { recursive: true, force: true }); }
  assert.match(read, /^"\/w\/work\/\*\*\/\.env" = "deny"$/m, 'workspace-rooted: the CLI expands globs at session start and refuses /**');
  assert.match(renderConfig(spec({ denyExtra: ['/etc/sb/alice.key', '/etc/sb/config.json'] }), meter), /^"\/etc\/sb\/alice\.key" = "deny"\n"\/etc\/sb\/config\.json" = "deny"$/m, 'the caller\'s key file and the config file');
  assert.doesNotMatch(read, /shell_tool/);
  const think = renderConfig(spec({ profile: 'think', effort: 'high' }), meter);
  assert.match(think, /^shell_tool = false$/m);
  assert.match(think, /^unified_exec = false$/m);
  assert.match(think, /^web_search = "disabled"$/m);
  assert.match(think, /^model_reasoning_effort = "high"$/m);
  assert.match(renderConfig(spec({ profile: 'write' }), meter), /^default_permissions = "swarm-write"$/m);
  const args = buildArgs(spec(), '/w/home/schema.json');
  assert.ok(!args.includes('-s') && !args.includes('--sandbox'), 'the -s flag would replace the permission profile');
  assert.ok(args.includes('--ephemeral') && args.includes('--ignore-rules') && args.includes('--json'));
  assert.equal(args.at(-1), '-');
  assert.deepEqual(args.slice(args.indexOf('--output-schema'), args.indexOf('--output-schema') + 2), ['--output-schema', '/w/home/schema.json']);
  assert.ok(denyPaths('/sb', '/w/home').includes(path.join(os.homedir(), '.ssh')));
});

test('renderConfig: only the write shell has network; read and think do not', () => {
  const m = { baseUrl: 'http://127.0.0.1:1/m', bearer: 'sbm_x' };
  const t = renderConfig(spec({ profile: 'write' }), m);
  assert.match(t, /\[permissions\.swarm-write\.network\]\nenabled = true/);
  // the outer wrapper shares the host network namespace: a read shell with network would reach the daemon's own dashboard
  assert.doesNotMatch(t, /swarm-read\.network/);
  assert.doesNotMatch(t, /swarm-think\.network/);
});

test('strictSchema: additionalProperties=false on every object, nothing else touched', () => {
  const s = strictSchema({
    type: 'object', properties: { ok: { type: 'boolean' }, items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } }, loose: { type: 'object', additionalProperties: true } },
    required: ['ok', 'items', 'loose'], $defs: { d: { properties: { x: { type: 'string' } } } },
  }) as any;
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.items.items.additionalProperties, false);
  assert.equal(s.properties.loose.additionalProperties, true, 'an explicit value is kept');
  assert.equal(s.$defs.d.additionalProperties, false, 'properties without type counts as an object');
  assert.deepEqual(s.required, ['ok', 'items', 'loose']);
  assert.equal(s.properties.ok.additionalProperties, undefined);
  const data = strictSchema({ type: 'object', properties: { kind: { type: 'string', enum: ['a'], default: { type: 'object' } } }, required: ['kind'] }) as any;
  assert.deepEqual(data.properties.kind.default, { type: 'object' }, 'data under default/enum/const is not a schema');
  assert.equal((strictSchema({ type: 'object', properties: { xs: { type: 'array', items: { anyOf: [{ type: 'object', properties: {} }, { type: 'null' }] } } }, required: ['xs'] }) as any).properties.xs.items.anyOf[0].additionalProperties, false, 'anyOf branches are schemas');
});

test('strictSchemaProblem: names what strict mode would reject', () => {
  assert.equal(strictSchemaProblem({ type: 'object', properties: { a: { type: 'string' }, b: { type: ['integer', 'null'] } }, required: ['a', 'b'] }), null);
  assert.match(strictSchemaProblem({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] })!, /#: every property must be listed in required .*missing: b/);
  assert.match(strictSchemaProblem({ type: 'object', properties: { a: { type: 'object', properties: { x: { type: 'string' } } } }, required: ['a'] })!, /#\/properties\/a: every property/);
  assert.match(strictSchemaProblem({ type: 'object', properties: {}, additionalProperties: true })!, /additionalProperties must be false/);
  assert.equal(strictSchemaProblem({ type: 'object', properties: {}, additionalProperties: false }), null);
});

test('outer bubblewrap: allow-list mounts, cwd writable only for write, env cleared', () => {
  const env = { PATH: '/usr/bin', HOME: '/w/home' };
  const ro = bwrapArgs(spec(), env);
  assert.deepEqual(ro.slice(0, 2), ['--unshare-user', '--unshare-pid']);
  assert.ok(ro.includes('--die-with-parent'));
  assert.deepEqual(ro.slice(ro.indexOf('--ro-bind'), ro.indexOf('--ro-bind') + 3), ['--ro-bind', '/usr', '/usr']);
  assert.ok(ro.join(' ').includes('--bind /w/home /w/home'));
  assert.ok(ro.join(' ').includes('--ro-bind /w/work /w/work'));
  assert.ok(!ro.join(' ').includes('--bind /w/work /w/work'));
  assert.ok(ro.join(' ').includes('--clearenv --setenv PATH /usr/bin --setenv HOME /w/home -- /usr/bin/codex'));
  assert.ok(ro.join(' ').includes('--tmpfs /tmp'));
  const rw = bwrapArgs(spec({ profile: 'write', extraRoBinds: ['/opt/ca'] }), env);
  assert.ok(rw.join(' ').includes('--bind /w/work /w/work'));
  assert.ok(rw.join(' ').includes('--ro-bind-try /opt/ca /opt/ca'));
  assert.ok(!rw.includes('/sb'), 'the data dir is not mounted');
  // a bare name (never passed by config any more) must not become `--ro-bind-try . .` over the sandbox root
  assert.deepEqual(binMounts(['codex', '/usr/bin/node']), []);
  assert.ok(!bwrapArgs(spec({ codexBin: 'codex' }), env).includes('.'));
});

test('outer bubblewrap: an npm-installed codex gets its node_modules tree and bin symlink dir', () => {
  // ~/.nvm-style layout: bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js,
  // with the platform package as a sibling the wrapper finds via require.resolve.
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-npm-'));
  const pkg = path.join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(path.join(prefix, 'lib', 'node_modules', '@openai', 'codex-linux-x64', 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'codex.js'), '#!/usr/bin/env node\n');
  fs.mkdirSync(path.join(prefix, 'bin'));
  fs.symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', path.join(prefix, 'bin', 'codex'));
  try {
    const mounts = binMounts([path.join(prefix, 'bin', 'codex'), '/usr/bin/node']);
    assert.deepEqual(new Set(mounts), new Set([path.join(prefix, 'bin'), path.join(prefix, 'lib', 'node_modules')]), 'symlink dir + the whole node_modules tree, nothing under /usr');
    const args = bwrapArgs(spec({ codexBin: path.join(prefix, 'bin', 'codex') }), { PATH: '/usr/bin' });
    const a = args.join(' ');
    assert.ok(a.includes(`--ro-bind-try ${path.join(prefix, 'lib', 'node_modules')} ${path.join(prefix, 'lib', 'node_modules')}`));
    assert.ok(a.includes(`--ro-bind-try ${path.join(prefix, 'bin')} ${path.join(prefix, 'bin')}`));
    assert.ok(a.endsWith(`-- ${path.join(prefix, 'bin', 'codex')}`));
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test('parseUsage: SSE without content-type, CRLF framing, JSON bodies, nothing for errors', () => {
  const sse = 'event: response.created\ndata: {"type":"response.created","response":{"usage":null}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-test","usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":800},"output_tokens":50}}}\n\n';
  assert.deepEqual(parseUsage(sse, ''), { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, model: 'gpt-test' });
  assert.deepEqual(parseUsage(sse.replace(/\n/g, '\r\n'), ''), { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, model: 'gpt-test' }, 'CRLF-framed SSE');
  assert.deepEqual(parseUsage(sse.replace(/\n\n$/, '\n'), 'text/event-stream')?.outputTokens, 50, 'a terminal event without its trailing blank line');
  assert.deepEqual(parseUsage('{"model":"m","usage":{"input_tokens":3,"output_tokens":4}}', 'application/json'), { inputTokens: 3, cachedInputTokens: 0, outputTokens: 4, model: 'm' });
  assert.equal(parseUsage('{"error":{"message":"nope"}}', 'application/json'), null);
  assert.equal(parseUsage('event: error\ndata: {"type":"error","message":"x"}\n\n', 'text/event-stream'), null);
});

// -- fake Responses backend ------------------------------------------------------
interface Seen { path: string; headers: http.IncomingHttpHeaders; body: any }
function fakeBackend(seen: Seen[], portOf?: () => number): http.Server {
  let n = 0;
  return http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* raw */ }
    seen.push({ path: req.url!, headers: req.headers, body });
    if (!req.url!.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
    n++;
    const model = body?.model ?? 'gpt-test';
    const ev = (type: string, o: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
    const input: any[] = Array.isArray(body?.input) ? body.input : [];
    const text = JSON.stringify(input);
    const hasToolOutput = input.some((i) => i.type === 'function_call_output');
    res.writeHead(200, { 'x-codex-primary-used-percent': '5' }); // like the live backend: no content-type
    res.write(ev('response.created', { response: { id: `resp_${n}`, model, status: 'in_progress', usage: null } }));
    let output: any[];
    if (text.includes('USE-TOOL') && !hasToolOutput) {
      const toolName = (body.tools ?? []).some((t: any) => t.name === 'exec_command') ? 'exec_command' : 'shell';
      const userText = input.filter((i) => i.role === 'user').flatMap((i) => (Array.isArray(i.content) ? i.content : [])).map((c) => String(c.text ?? '')).join('\n');
      const custom = /CMD:(.*)$/m.exec(userText)?.[1];
      const cmd = custom ?? 'cat hello.txt; cat ../sb.key; cat ../secret/key.txt; ls ..'
        + (portOf ? `; (exec 3<>/dev/tcp/127.0.0.1/${portOf()}) 2>/dev/null && echo NET-OK || echo NET-FAIL` : '');
      const args = toolName === 'exec_command' ? { cmd, yield_time_ms: 5000 } : { command: ['bash', '-lc', cmd] };
      const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: toolName, arguments: JSON.stringify(args) };
      output = [item];
    } else {
      const outs = input.filter((i) => i.type === 'function_call_output').map((i) => String(i.output));
      const answer = text.includes('SCHEMA') ? '{"answer":"yes"}' : outs.length ? `tool said: ${outs.join(' | ')}` : `answer #${n}`;
      const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer }] };
      output = [item];
    }
    for (const item of output) {
      res.write(ev('response.output_item.added', { output_index: 0, item }));
      res.write(ev('response.output_item.done', { output_index: 0, item }));
    }
    res.write(ev('response.completed', { response: { id: `resp_${n}`, model, status: 'completed', output, usage: { input_tokens: 700, input_tokens_details: { cached_tokens: n > 1 ? 500 : 0 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 730 } } }));
    res.end();
  });
}
async function listen(s: http.Server): Promise<number> {
  s.listen(0, '127.0.0.1'); await once(s, 'listening');
  return (s.address() as { port: number }).port;
}

test('meter: swaps the bearer, adds attribution, relays the stream, reports usage; unknown bearers get 401', async () => {
  const seen: Seen[] = [];
  const up = fakeBackend(seen);
  const upPort = await listen(up);
  const meter = new UsageMeter();
  await meter.start();
  const usages: any[] = [];
  const slot = meter.register({ upstream: `http://127.0.0.1:${upPort}`, bearer: 'gt_real', headers: { 'x-gate-origin': 'swarmbase', 'x-gate-channel': 'r1' }, onUsage: (u, st) => usages.push({ ...u, st }) });
  assert.match(slot.bearer, /^sbm_[0-9a-f]{64}$/);
  const post = (bearer: string) => fetch(`${slot.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'x-gate-origin': 'spoofed' }, body: JSON.stringify({ model: 'gpt-test', input: [{ role: 'user', content: 'hi' }], stream: true }) });
  const r = await post(slot.bearer);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /response\.completed/);
  assert.equal(r.headers.get('x-codex-primary-used-percent'), '5');
  assert.equal(seen[0].headers.authorization, 'Bearer gt_real');
  assert.equal(seen[0].headers['x-gate-origin'], 'swarmbase', 'caller-sent attribution is replaced');
  assert.equal(seen[0].headers['x-gate-channel'], 'r1');
  assert.equal(seen[0].path, '/responses');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(usages, [{ inputTokens: 700, cachedInputTokens: 0, outputTokens: 30, model: 'gpt-test', st: 200 }]);
  assert.equal((await post('sbm_nope')).status, 401);
  // one route only: the bearer is worth nothing on any other path of the gateway
  const raw = (method: string, p: string) => new Promise<number>((resolve, reject) => {
    const u = new URL(slot.baseUrl);
    const r = http.request({ host: u.hostname, port: u.port, method, path: p, headers: { authorization: `Bearer ${slot.bearer}`, 'content-type': 'application/json', 'content-length': '2' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on('error', reject);
    r.end('{}');
  });
  assert.equal(await raw('GET', '/m/responses'), 404);
  assert.equal(await raw('POST', '/m/models'), 404);
  assert.equal(await raw('POST', '/m/../anthropic/v1/messages'), 404);
  assert.equal(await raw('POST', '/m/%2e%2e/admin/status'), 404);
  assert.equal(await raw('POST', '/m/responses?x=1'), 404);
  assert.equal(seen.length, 1, 'nothing but POST /m/responses reached the backend');
  meter.release(slot.bearer);
  assert.equal((await post(slot.bearer)).status, 401);
  await meter.stop();
  up.close();
});

test('meter: a long stream is still counted; a dropped client or a released slot cuts the upstream request', async () => {
  // backend 1: 60k delta events (~12 MB) before the terminal event
  const big = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200);
    const delta = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(150) })}\n\n`;
    let i = 0;
    const pump = () => { while (i < 60_000) { i++; if (!res.write(delta)) { res.once('drain', pump); return; } } res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-test', usage: { input_tokens: 10, output_tokens: 60_000 } } })}\n\n`); };
    pump();
  });
  // backend 2: streams forever until the client goes away
  let upstreamClosedEarly = false;
  const slow = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200);
    const t = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'y' })}\n\n`), 10);
    res.on('close', () => { clearInterval(t); if (!res.writableFinished) upstreamClosedEarly = true; });
  });
  const bigPort = await listen(big);
  const slowPort = await listen(slow);
  const meter = new UsageMeter();
  await meter.start();
  try {
    const usages: any[] = [];
    const s1 = meter.register({ upstream: `http://127.0.0.1:${bigPort}`, bearer: 'gt', headers: {}, onUsage: (u) => usages.push(u) });
    const r = await fetch(`${s1.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${s1.bearer}` }, body: '{}' });
    const text = await r.text();
    assert.ok(text.length > 10_000_000, `relayed ${text.length} bytes`);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(usages, [{ inputTokens: 10, cachedInputTokens: 0, outputTokens: 60_000, model: 'gpt-test' }]);

    const s2 = meter.register({ upstream: `http://127.0.0.1:${slowPort}`, bearer: 'gt', headers: {}, onUsage: () => {} });
    const ac = new AbortController();
    const r2 = await fetch(`${s2.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${s2.bearer}` }, body: '{}', signal: ac.signal });
    assert.equal(r2.status, 200);
    ac.abort();
    for (let i = 0; i < 100 && !upstreamClosedEarly; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(upstreamClosedEarly, 'the client went away: the upstream request was destroyed');

    upstreamClosedEarly = false;
    const s3 = meter.register({ upstream: `http://127.0.0.1:${slowPort}`, bearer: 'gt', headers: {}, onUsage: () => {} });
    const r3 = await fetch(`${s3.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${s3.bearer}` }, body: '{}' });
    assert.equal(r3.status, 200);
    meter.release(s3.bearer);
    for (let i = 0; i < 100 && !upstreamClosedEarly; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(upstreamClosedEarly, 'the slot was released (agent killed): the upstream request was destroyed');
    await assert.rejects(r3.text(), 'the client stream ends with an error, not a clean end');
  } finally {
    await meter.stop();
    big.close();
    slow.close();
  }
});

test('normalizeTranscript: codex exec JSONL', () => {
  const raw = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls","status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"a\\n","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"done"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
  ].join('\n');
  const items = normalizeTranscript(raw) as any[];
  assert.deepEqual(items.map((i) => i.kind), ['init', 'tool_use', 'tool_result', 'text', 'result']);
  assert.equal(items[1].input, 'ls');
  assert.equal(items[4].usage.output_tokens, 2);
});

// -- live: the real CLI ----------------------------------------------------------
function findCodex(): string | null {
  for (const p of [process.env.CODEX_BIN, '/usr/lib/chatgpt/resources/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local/bin/codex')]) {
    if (p && fs.existsSync(p)) return p;
  }
  try { return execFileSync('which', ['codex'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}
const codexBin = findCodex();
const liveSkip = !codexBin ? 'no codex CLI on this machine (set CODEX_BIN)' : !bwrapAvailable() ? 'no bubblewrap on this machine' : false;

/** A data dir shaped like ~/.swarmbase: secrets beside the run, the workspace inside it. */
function fixture(): { dataDir: string; runDir: string; work: string } {
  const dataDir = fs.mkdtempSync(path.join(os.homedir(), '.swarmbase-test-'));
  const runDir = path.join(dataDir, 'runs', 'r1');
  const work = path.join(runDir, 'work');
  fs.mkdirSync(path.join(runDir, 'agents'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(runDir, 'secret'), { recursive: true });
  fs.writeFileSync(path.join(work, 'hello.txt'), 'HELLO\n');
  fs.writeFileSync(path.join(runDir, 'sb.key'), 'CANARY-KEY\n');
  fs.writeFileSync(path.join(runDir, 'secret', 'key.txt'), 'CANARY-SECRET\n');
  fs.writeFileSync(path.join(runDir, 'meta.json'), '{"canary":"CANARY-META"}');
  return { dataDir, runDir, work };
}

test('live: codex exec through the meter — isolation, no network for read, network for write, schema, think, token ceiling', { skip: liveSkip }, async () => {
  const seen: Seen[] = [];
  let upPort = 0;
  const up = fakeBackend(seen, () => upPort);
  upPort = await listen(up);
  const meter = new UsageMeter();
  await meter.start();
  const { dataDir, runDir, work } = fixture();
  const base = (n: number, over: Partial<CodexAgentSpec> = {}): CodexAgentSpec => spec({
    n, cwd: work, dataDir, homeDir: path.join(runDir, 'agents', `${n}-home`), streamPath: path.join(runDir, 'agents', `${n}.jsonl`),
    apiKey: 'gt_real', baseUrl: `http://127.0.0.1:${upPort}`, codexBin: codexBin!, sandbox: 'bwrap', maxBudgetUsd: null, timeoutMs: 120_000, ...over,
  });
  const run = (s: CodexAgentSpec) => {
    const acts: string[] = [];
    return runCodexAgent(s, meter, new AbortController().signal, (a) => acts.push(`${a.kind}:${a.summary}`)).then((o) => ({ o, acts }));
  };
  try {
    // 1. tool-call round trip; the command tries to read beside the workspace and to open a loopback socket
    const t = await run(base(1, { prompt: 'USE-TOOL' }));
    assert.equal(t.o.ok, true, t.o.error ?? '');
    const said = String(t.o.result);
    assert.match(said, /HELLO/);
    assert.doesNotMatch(said, /CANARY/, `a secret beside the workspace was readable: ${said}`);
    assert.match(said, /NET-FAIL/, 'the read shell must not reach the host loopback (the daemon dashboard lives there)');
    assert.equal(t.o.tokens, 1460); // two responses of 730
    assert.equal(t.o.unpriced, true);
    assert.equal(t.o.costUsd, 0);
    assert.ok(seen.every((s) => s.headers.authorization === 'Bearer gt_real' && s.headers['x-gate-origin'] === 'swarmbase'));
    assert.equal(seen[0].body.prompt_cache_key, seen[1].body.prompt_cache_key, 'one prompt-cache key per agent');
    assert.ok(!fs.existsSync(path.join(runDir, 'agents', '1-home')), 'the throwaway CODEX_HOME is deleted');
    assert.ok(fs.existsSync(path.join(runDir, 'agents', '1.jsonl')), 'the raw stream is kept');
    // 1b. the write shell has network (trusted callers only), still no reads beside the workspace
    seen.length = 0;
    const w = await run(base(5, { prompt: 'USE-TOOL', profile: 'write' }));
    assert.equal(w.o.ok, true, w.o.error ?? '');
    assert.match(String(w.o.result), /NET-OK/, 'the write shell can open a TCP connection');
    assert.doesNotMatch(String(w.o.result), /CANARY/);
    // 2. structured output
    seen.length = 0;
    const s = await run(base(2, { prompt: 'SCHEMA', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } }));
    assert.equal(s.o.ok, true, s.o.error ?? '');
    assert.deepEqual(s.o.result, { answer: 'yes' });
    assert.equal(seen[0].body.text?.format?.type, 'json_schema');
    assert.equal(seen[0].body.text?.format?.schema?.additionalProperties, false, 'the engine made the schema strict');
    // 3. think: no tools offered to the model
    seen.length = 0;
    const th = await run(base(3, { prompt: 'think', profile: 'think' }));
    assert.equal(th.o.ok, true, th.o.error ?? '');
    assert.deepEqual(seen[0].body.tools ?? [], []);
    // 4. token ceiling: the first response (730 tokens) crosses it
    const c = await run(base(4, { prompt: 'USE-TOOL', maxTokens: 100 }));
    assert.equal(c.o.ok, false);
    assert.equal(c.o.reason, 'token-ceiling');
    assert.match(String(c.o.error), /token ceiling/);
    assert.ok(c.o.tokens >= 730);
    assert.equal(meter.active, 0);
  } finally {
    await meter.stop();
    up.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('live: sandbox "none" — the CLI deny-list alone hides sibling bearers, the key file, .env and token files', { skip: liveSkip }, async () => {
  const seen: Seen[] = [];
  const up = fakeBackend(seen);
  const upPort = await listen(up);
  const meter = new UsageMeter();
  await meter.start();
  const { dataDir, runDir, work } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-outside-'));
  // what a shell under `none` can try for: another agent's CODEX_HOME, files the workspace itself holds, and the caller's secrets outside the data dir
  fs.mkdirSync(path.join(runDir, 'agents', '2-home'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'agents', '2-home', 'config.toml'), 'http_headers = { authorization = "Bearer CANARY-SIBLING-BEARER" }\n');
  fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(work, '.env'), 'CANARY-DOTENV\n');
  fs.writeFileSync(path.join(work, '.env.local'), 'CANARY-DOTENV-LOCAL\n');
  fs.writeFileSync(path.join(work, 'sub', 'api.token'), 'CANARY-TOKEN\n');
  fs.writeFileSync(path.join(work, 'sub', 'credentials.json'), 'CANARY-CREDENTIALS\n');
  fs.writeFileSync(path.join(outside, 'alice.key'), 'CANARY-APIKEY\n');
  fs.writeFileSync(path.join(outside, 'config.json'), '{"canary":"CANARY-CONFIG"}\n');
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), '{"canary":"CANARY-EVENTS"}\n');
  // (the fixture's `runs/r1/sb.key` is not a real daemon artifact — key files live at `<dataDir>/*.key` or wherever `apiKeyFile` points — so it is not a target here)
  const targets = ['hello.txt', '../agents/2-home/config.toml', '.env', '.env.local', 'sub/api.token', 'sub/credentials.json', path.join(outside, 'alice.key'), path.join(outside, 'config.json'), '../meta.json', '../events.jsonl'];
  const s = spec({
    n: 1, cwd: work, dataDir, homeDir: path.join(runDir, 'agents', '1-home'), streamPath: path.join(runDir, 'agents', '1.jsonl'),
    apiKey: 'gt_real', baseUrl: `http://127.0.0.1:${upPort}`, codexBin: codexBin!, sandbox: 'none', maxBudgetUsd: null, timeoutMs: 120_000,
    prompt: `USE-TOOL CMD:${targets.map((t) => `echo "== ${t}"; cat ${JSON.stringify(t)} 2>&1`).join('; ')}`,
    denyExtra: [path.join(outside, 'alice.key'), path.join(outside, 'config.json')],
  });
  try {
    const o = await runCodexAgent(s, meter, new AbortController().signal, () => {});
    assert.equal(o.ok, true, o.error ?? '');
    const said = String(o.result);
    assert.match(said, /HELLO/);
    assert.doesNotMatch(said, /CANARY/, `readable under sandbox "none": ${said}`);
  } finally {
    await meter.stop();
    up.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
