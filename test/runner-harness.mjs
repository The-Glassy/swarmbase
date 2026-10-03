// Drives dist/src/runner/runner.js directly with a fake parent. Usage: node test/runner-harness.mjs
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runner = resolve(root, 'dist/src/runner/runner.js');

function runScript(script, args, answer) {
  return new Promise((res) => {
    const child = fork(runner, [], { execArgv: ['--experimental-permission', `--allow-fs-read=${root}/*`, '--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const msgs = []; let stderr = '';
    child.stderr.on('data', (c) => stderr += c);
    child.on('message', (m) => {
      msgs.push(m);
      if (m.type === 'agent') {
        const r = answer(m);
        setTimeout(() => child.send(r.error ? { type: 'agentError', callId: m.callId, message: r.error } : { type: 'agentResult', callId: m.callId, json: JSON.stringify(r.value) }), 5);
      }
      if (m.type === 'done' || m.type === 'fail') { child.kill(); res({ msgs, end: m, stderr }); }
    });
    child.on('exit', (code) => res({ msgs, end: { type: 'exit', code }, stderr }));
    child.send({ type: 'start', script, args, budgetUsd: 1 });
  });
}

const cases = [
  ['basic pipeline/parallel', `export const meta = { name: 'demo' }
phase('A'); log('hello', {x:1})
const xs = await parallel([1,2,3].map(i => () => agent('p'+i, {label:'a'+i})))
const ys = await pipeline(['u','v'], (x) => agent('s1 '+x), (prev, item, i) => agent('s2 '+prev+' '+item+' '+i))
return { xs, ys, args, total: budget.total }`, { k: 1 }],
  ['agent null + filter', `const r = await parallel([() => agent('ok'), () => agent('nul'), () => { throw new Error('boom') }]); return r.filter(Boolean)`],
  ['agent throws (budget)', `try { await agent('BUDGET') } catch (e) { return 'caught: ' + e.message }`],
  ['Math.random blocked', `return Math.random()`],
  ['Date.now blocked', `return Date.now()`],
  ['new Date() blocked', `return new Date().toISOString()`],
  ['new Date(x) ok', `return new Date(0).toISOString()`],
  ['escape via agent.constructor', `return typeof agent.constructor('return typeof process')()`],
  ['escape via promise.constructor', `const p = agent('ok'); const F = p.constructor.constructor; await p; return F('return typeof process')()`],
  ['escape via log fn', `return log.constructor('return typeof require + typeof process')()`],
  ['syntax error', `return (`],
  ['top-level sync loop timeout', `while(true){}`],
  ['unserializable return', `const a = {}; a.a = a; return a`],
];
for (const [name, script, args] of cases) {
  const r = await runScript(script, args, (m) => m.prompt === 'nul' ? { value: null } : m.prompt === 'BUDGET' ? { error: 'budget exhausted: $1.00 of $1.00 spent' } : { value: 'R(' + m.prompt + ')' });
  const extra = r.msgs.filter(m => m.type === 'meta' || m.type === 'phase' || m.type === 'log').map(m => m.type + ':' + (m.json ?? m.title ?? m.message)).join(' | ');
  console.log(`--- ${name}\n    end: ${JSON.stringify(r.end).slice(0, 300)}${extra ? `\n    side: ${extra.slice(0, 300)}` : ''}${r.stderr ? `\n    stderr: ${r.stderr.slice(0, 200)}` : ''}`);
}
