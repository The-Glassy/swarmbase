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
import { parseConfig } from '../src/config.js';
import { normalizeTranscript } from '../src/dashboard.js';
import { binMounts, bwrapArgs, bwrapAvailable, buildArgs, denyPaths, renderConfig, runCodexAgent, type CodexAgentSpec } from '../src/engines/codex.js';
import { parseUsage, UsageMeter } from '../src/meter.js';

const caller = { name: 'r', tokenSha256: 'a'.repeat(64), apiKeyFile: '/tmp/x.key' };

test('config: legacy keys map onto engines.claude; codex needs a baseUrl; per-engine defaults', () => {
  const c = parseConfig({ apiBaseUrl: 'https://g/anthropic', claudeBin: '/x/claude', callers: [{ ...caller, engines: ['claude'] }] } as any);
  assert.equal(c.engines.claude.baseUrl, 'https://g/anthropic');
  assert.equal(c.engines.claude.bin, '/x/claude');
  assert.equal(c.apiBaseUrl, 'https://g/anthropic');
  assert.equal(c.engines.codex.baseUrl, null);
  assert.equal(c.callers[0].defaultModels.claude, 'claude-sonnet-5-5');
  assert.throws(() => parseConfig({ callers: [{ ...caller, engines: ['claude', 'codex'] }] } as any), /engines\.codex\.baseUrl/);
  assert.throws(() => parseConfig({ callers: [{ ...caller, engines: ['gemini'] }] } as any), /unknown engine/);
  const d = parseConfig({ engines: { codex: { baseUrl: 'https://g/codex', sandbox: 'none' } }, callers: [{ ...caller, engines: ['codex'], defaultModel: 'claude-opus-5-5', defaultModels: { codex: 'gpt-x' } }] } as any);
  assert.equal(d.engines.codex.sandbox, 'none');
  assert.equal(d.engines.codex.bin, 'codex');
  assert.deepEqual(d.callers[0].defaultModels, { claude: 'claude-opus-5-5', codex: 'gpt-x' });
  assert.equal(d.callers[0].defaultModel, 'claude-opus-5-5');
  assert.throws(() => parseConfig({ engines: { codex: { baseUrl: 'x', sandbox: 'firejail' } }, callers: [] } as any), /sandbox/);
});

function spec(over: Partial<CodexAgentSpec> = {}): CodexAgentSpec {
  return {
    runId: 'r1', n: 1, label: 'a', prompt: 'hi', schema: null, model: 'gpt-test', effort: null, profile: 'read',
    cwd: '/w/work', timeoutMs: 60_000, maxBudgetUsd: 1, maxTokens: 1_000_000, streamPath: '/dev/null',
    homeDir: '/w/home', apiKey: 'gt_real', baseUrl: 'https://g/codex', codexBin: '/usr/bin/codex', sandbox: 'bwrap', extraRoBinds: [], dataDir: '/sb',
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
  assert.match(read, /^"\/sb\/runs\/\*\/meta\.json" = "deny"$/m);
  assert.match(read, /^"\/w\/home\/config\.toml" = "deny"$/m);
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

test('parseUsage: SSE without content-type, JSON bodies, nothing for errors', () => {
  const sse = 'event: response.created\ndata: {"type":"response.created","response":{"usage":null}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-test","usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":800},"output_tokens":50}}}\n\n';
  assert.deepEqual(parseUsage(sse, ''), { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, model: 'gpt-test' });
  assert.deepEqual(parseUsage('{"model":"m","usage":{"input_tokens":3,"output_tokens":4}}', 'application/json'), { inputTokens: 3, cachedInputTokens: 0, outputTokens: 4, model: 'm' });
  assert.equal(parseUsage('{"error":{"message":"nope"}}', 'application/json'), null);
  assert.equal(parseUsage('event: error\ndata: {"type":"error","message":"x"}\n\n', 'text/event-stream'), null);
});

// -- fake Responses backend ------------------------------------------------------
interface Seen { path: string; headers: http.IncomingHttpHeaders; body: any }
function fakeBackend(seen: Seen[]): http.Server {
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
      const cmd = 'cat hello.txt; cat ../sb.key; cat ../secret/key.txt; ls ..';
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
  meter.release(slot.bearer);
  assert.equal((await post(slot.bearer)).status, 401);
  await meter.stop();
  up.close();
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

test('live: codex exec through the meter — isolation, schema, think profile, token ceiling', { skip: codexBin ? false : 'no codex CLI on this machine (set CODEX_BIN)' }, async () => {
  const seen: Seen[] = [];
  const up = fakeBackend(seen);
  const upPort = await listen(up);
  const meter = new UsageMeter();
  await meter.start();
  const sandbox = bwrapAvailable() ? 'bwrap' : 'none';
  // a data dir shaped like ~/.swarmbase: secrets beside the run, the workspace inside it
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
  const base = (n: number, over: Partial<CodexAgentSpec> = {}): CodexAgentSpec => spec({
    n, cwd: work, dataDir, homeDir: path.join(runDir, 'agents', `${n}-home`), streamPath: path.join(runDir, 'agents', `${n}.jsonl`),
    apiKey: 'gt_real', baseUrl: `http://127.0.0.1:${upPort}`, codexBin: codexBin!, sandbox, maxBudgetUsd: null, timeoutMs: 120_000, ...over,
  });
  const run = (s: CodexAgentSpec) => {
    const acts: string[] = [];
    return runCodexAgent(s, meter, new AbortController().signal, (a) => acts.push(`${a.kind}:${a.summary}`)).then((o) => ({ o, acts }));
  };
  try {
    // 1. tool-call round trip; the command tries to read beside the workspace
    const t = await run(base(1, { prompt: 'USE-TOOL' }));
    assert.equal(t.o.ok, true, t.o.error ?? '');
    const said = String(t.o.result);
    assert.match(said, /HELLO/);
    assert.doesNotMatch(said, /CANARY/, `a secret beside the workspace was readable (sandbox=${sandbox}): ${said}`);
    assert.equal(t.o.tokens, 1460); // two responses of 730
    assert.equal(t.o.unpriced, true);
    assert.equal(t.o.costUsd, 0);
    assert.ok(seen.every((s) => s.headers.authorization === 'Bearer gt_real' && s.headers['x-gate-origin'] === 'swarmbase'));
    assert.equal(seen[0].body.prompt_cache_key, seen[1].body.prompt_cache_key, 'one prompt-cache key per agent');
    assert.ok(!fs.existsSync(path.join(runDir, 'agents', '1-home')), 'the throwaway CODEX_HOME is deleted');
    assert.ok(fs.existsSync(path.join(runDir, 'agents', '1.jsonl')), 'the raw stream is kept');
    // 2. structured output
    seen.length = 0;
    const s = await run(base(2, { prompt: 'SCHEMA', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } }));
    assert.equal(s.o.ok, true, s.o.error ?? '');
    assert.deepEqual(s.o.result, { answer: 'yes' });
    assert.equal(seen[0].body.text?.format?.type, 'json_schema');
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
