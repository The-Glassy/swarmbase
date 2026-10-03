/**
 * Script runner — one child process per run, launched by the daemon as
 *   node --experimental-permission --allow-fs-read=<swarmbase>/* runner.js
 * so the process itself can't write files or spawn programs.
 *
 * Inside it the workflow script runs in a vm context whose only connection to
 * this realm is a bridge of primitives and callbacks, captured in a prelude
 * closure and then deleted from the context's globals. No host-realm object
 * (and so no host `Function` constructor) is reachable from the script.
 * This is defense in depth, not a hard sandbox; the real capability is
 * agent(), and the daemon polices every agent() request as untrusted input.
 *
 * Protocol (process IPC, JSON):
 *   parent → child  {type:'start', script, args, budgetUsd}
 *                   {type:'agentResult', callId, json} | {type:'agentError', callId, message}
 *                   {type:'spent', usd}
 *   child → parent  {type:'meta', json} {type:'phase', title} {type:'log', message}
 *                   {type:'agent', callId, prompt, optsJson}
 *                   {type:'done', json} | {type:'fail', message, stack}
 */
import vm from 'node:vm';
import { wrapScript } from './wrap.js';

interface StartMsg { type: 'start'; script: string; args: unknown; budgetUsd: number }
type ParentMsg =
  | StartMsg
  | { type: 'agentResult'; callId: number; json: string }
  | { type: 'agentError'; callId: number; message: string }
  | { type: 'spent'; usd: number }
  | { type: 'ping' };

const send = (m: unknown): void => { process.send?.(m); };

let spentUsd = 0;
let nextCallId = 1;
const pending = new Map<number, { ok: (json: string) => void; err: (msg: string) => void }>();
let finished = false;

/** Every bridge method swallows its own failures: an exception thrown in this
 *  realm must never propagate into the script as a host-realm Error. */
const guard = <A extends unknown[], R>(fn: (...a: A) => R, fallback: R) => (...a: A): R => {
  try { return fn(...a); } catch { return fallback; }
};

const rawBridge = {
  agent(prompt: string, optsJson: string, ok: (json: string) => void, err: (msg: string) => void): void {
    const callId = nextCallId++;
    pending.set(callId, { ok, err });
    send({ type: 'agent', callId, prompt: String(prompt), optsJson: String(optsJson) });
  },
  phase(title: string): void { send({ type: 'phase', title: String(title) }); },
  log(message: string): void { send({ type: 'log', message: String(message) }); },
  spent(): number { return spentUsd; },
  done(json: string): void {
    if (finished) return;
    finished = true;
    send({ type: 'done', json: String(json) });
  },
  fail(message: string, stack: string): void {
    if (finished) return;
    finished = true;
    send({ type: 'fail', message: String(message), stack: String(stack) });
  },
};

/** Runs inside the context. Everything it defines is a context-realm object. */
const PRELUDE = String.raw`
(() => {
  'use strict';
  const b = globalThis.__sb_bridge;
  const ARGS_JSON = globalThis.__sb_args;
  const TOTAL = globalThis.__sb_budget;
  delete globalThis.__sb_bridge;
  delete globalThis.__sb_args;
  delete globalThis.__sb_budget;

  const unavailable = (what) => () => {
    throw new Error(what + ' is unavailable in SwarmBase scripts (it would break resume) — pass timestamps or seeds in via args');
  };
  Math.random = unavailable('Math.random()');
  const RealDate = Date;
  function SBDate(...a) {
    if (!new.target) throw new Error('Date() is unavailable in SwarmBase scripts (it would break resume)');
    if (a.length === 0) throw new Error('new Date() with no arguments is unavailable in SwarmBase scripts (it would break resume)');
    return new RealDate(...a);
  }
  SBDate.prototype = RealDate.prototype;
  SBDate.UTC = RealDate.UTC;
  SBDate.parse = RealDate.parse;
  SBDate.now = unavailable('Date.now()');
  globalThis.Date = SBDate;

  const str = (v) => {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const log = (...parts) => b.log(parts.map(str).join(' '));

  globalThis.log = (message) => b.log(str(message));
  globalThis.phase = (title) => b.phase(str(title));
  globalThis.console = { log, info: log, warn: log, error: log, debug: log };
  globalThis.args = ARGS_JSON === undefined ? undefined : JSON.parse(ARGS_JSON);
  globalThis.budget = Object.freeze({
    total: TOTAL,
    spent: () => b.spent(),
    remaining: () => Math.max(0, TOTAL - b.spent()),
  });

  globalThis.agent = function agent(prompt, opts) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return Promise.reject(new TypeError('agent(prompt, opts?): prompt must be a non-empty string'));
    }
    let optsJson;
    try { optsJson = JSON.stringify(opts === undefined ? {} : opts); }
    catch { return Promise.reject(new TypeError('agent(): opts must be JSON-serializable')); }
    return new Promise((resolve, reject) => {
      b.agent(prompt, optsJson,
        (json) => resolve(JSON.parse(json)),
        (message) => reject(new Error(message)));
    });
  };

  globalThis.parallel = async function parallel(thunks) {
    if (!Array.isArray(thunks)) throw new TypeError('parallel(thunks): expected an array of functions');
    if (thunks.length > 4096) throw new RangeError('parallel(): at most 4096 items per call');
    return Promise.all(thunks.map(async (t, i) => {
      try { return await t(); }
      catch (e) { b.log('parallel[' + i + '] failed: ' + (e && e.message ? e.message : String(e))); return null; }
    }));
  };

  globalThis.pipeline = async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) throw new TypeError('pipeline(items, ...stages): items must be an array');
    if (items.length > 4096) throw new RangeError('pipeline(): at most 4096 items per call');
    return Promise.all(items.map(async (item, i) => {
      let prev = item;
      for (let s = 0; s < stages.length; s++) {
        try { prev = await stages[s](prev, item, i); }
        catch (e) {
          b.log('pipeline item ' + i + ' dropped at stage ' + (s + 1) + ': ' + (e && e.message ? e.message : String(e)));
          return null;
        }
      }
      return prev;
    }));
  };

  globalThis.workflow = () => { throw new Error('workflow() nesting is not supported by SwarmBase yet'); };

  globalThis.__sb_finish = (r) => {
    let json;
    try { json = JSON.stringify(r === undefined ? null : r); }
    catch (e) { b.fail('return value is not JSON-serializable: ' + e.message, ''); return; }
    b.done(json === undefined ? 'null' : json);
  };
  globalThis.__sb_fail = (e) => {
    b.fail(e && e.message ? e.message : String(e), e && e.stack ? String(e.stack) : '');
  };
})();
`;

function start(m: StartMsg): void {
  const ctx = vm.createContext({});
  (ctx as Record<string, unknown>).__sb_bridge = bridge;
  (ctx as Record<string, unknown>).__sb_args = m.args === undefined ? undefined : JSON.stringify(m.args);
  (ctx as Record<string, unknown>).__sb_budget = m.budgetUsd;
  vm.runInContext(PRELUDE, ctx, { filename: 'swarmbase-prelude.js' });
  let script: vm.Script;
  try {
    script = new vm.Script(wrapScript(m.script), { filename: 'workflow.js', lineOffset: -1 });
  } catch (e) {
    bridge.fail(`script does not compile: ${(e as Error).message}`, (e as Error).stack ?? '');
    return;
  }
  try {
    // The timeout bounds only the synchronous part (a top-level busy loop).
    script.runInContext(ctx, { timeout: 10_000 });
  } catch (e) {
    bridge.fail((e as Error).message, (e as Error).stack ?? '');
    return;
  }
  const meta = (ctx as Record<string, unknown>).__sb_meta;
  if (meta !== undefined) {
    try { send({ type: 'meta', json: JSON.stringify(meta) }); } catch { /* unserializable meta is just not shown */ }
  }
}

const bridge = {
  agent: guard(rawBridge.agent, undefined),
  phase: guard(rawBridge.phase, undefined),
  log: guard(rawBridge.log, undefined),
  spent: guard(rawBridge.spent, 0),
  done: guard(rawBridge.done, undefined),
  fail: guard(rawBridge.fail, undefined),
};

process.on('message', (raw: unknown) => {
  const m = raw as ParentMsg;
  switch (m.type) {
    case 'start': start(m); break;
    case 'spent': spentUsd = m.usd; break;
    case 'ping': send({ type: 'pong' }); break;
    case 'agentResult': { const p = pending.get(m.callId); pending.delete(m.callId); try { p?.ok(m.json); } catch { /* script-side */ } break; }
    case 'agentError': { const p = pending.get(m.callId); pending.delete(m.callId); try { p?.err(m.message); } catch { /* script-side */ } break; }
  }
});

process.on('disconnect', () => process.exit(0));
