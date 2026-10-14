// The run store deletes a finished run's work dir and sweeps leftovers on boot,
// but never the work dir of a running run or of one started with keepWork.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { RunStore, type RunMeta } from '../src/store.js';

function mkStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'swarmbase-store-'));
  return { dataDir, store: new RunStore(dataDir) };
}

function fill(dir: string) {
  mkdirSync(join(dir, 'repo', 'src'), { recursive: true });
  writeFileSync(join(dir, 'repo', 'src', 'a.txt'), 'x');
  writeFileSync(join(dir, 'frames.bin'), 'y');
}

const base = { caller: 'nestor', label: null, script: 'return 1', args: null, defaults: {}, budgetUsd: 1, budgetTokens: 0, resumedFrom: null } as const;

test('deleteWork empties the work dir and keeps the directory', () => {
  const { dataDir, store } = mkStore();
  try {
    const meta = store.create({ ...base });
    fill(store.workDir(meta));
    assert.equal(store.deleteWork(meta), true);
    assert.ok(existsSync(store.workDir(meta)));
    assert.deepEqual(readdirSync(store.workDir(meta)), []);
    assert.equal(store.deleteWork(meta), false);
    // nothing else of the run is touched
    assert.ok(existsSync(join(meta.dir, 'script.js')));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('sweepWork skips running runs and keepWork runs', () => {
  const { dataDir, store } = mkStore();
  try {
    const running = store.create({ ...base });
    const kept = store.create({ ...base, keepWork: true });
    const ended = store.create({ ...base });
    for (const m of [running, kept, ended]) fill(store.workDir(m));
    kept.status = 'completed'; store.saveMeta(kept);
    ended.status = 'interrupted'; store.saveMeta(ended);

    const swept = store.sweepWork();
    assert.deepEqual(swept.map((m) => m.id), [ended.id]);
    assert.deepEqual(readdirSync(store.workDir(ended)), []);
    assert.ok(readdirSync(store.workDir(running)).length > 0);
    assert.ok(readdirSync(store.workDir(kept)).length > 0);
    assert.equal(kept.keepWork, true);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('deleteWork unlinks a work dir that was swapped for a symlink instead of following it', () => {
  const { dataDir, store } = mkStore();
  try {
    const meta = store.create({ ...base });
    const outside = join(dataDir, 'outside');
    mkdirSync(outside); writeFileSync(join(outside, 'precious.txt'), 'z');
    rmSync(store.workDir(meta), { recursive: true });
    symlinkSync(outside, store.workDir(meta));
    assert.equal(store.deleteWork(meta), true);
    assert.ok(existsSync(join(outside, 'precious.txt')), 'the symlink target is untouched');
    assert.ok(lstatSync(store.workDir(meta)).isDirectory(), 'work is a real, empty directory again');
    assert.deepEqual(readdirSync(store.workDir(meta)), []);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('deleteWork removes a read-only tree (a toolchain module cache)', () => {
  const { dataDir, store } = mkStore();
  try {
    const meta = store.create({ ...base });
    const ro = join(store.workDir(meta), 'pkg', 'mod', 'x@v1');
    mkdirSync(ro, { recursive: true });
    writeFileSync(join(ro, 'f.go'), 'x');
    chmodSync(ro, 0o555);
    chmodSync(join(store.workDir(meta), 'pkg'), 0o555);
    assert.equal(store.deleteWork(meta), true);
    assert.deepEqual(readdirSync(store.workDir(meta)), []);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('sweepWork reports a run it could not clean and carries on', () => {
  const { dataDir, store } = mkStore();
  try {
    const bad = store.create({ ...base });
    const good = store.create({ ...base });
    for (const m of [bad, good]) { fill(store.workDir(m)); m.status = 'completed'; store.saveMeta(m); }
    const orig = store.deleteWork.bind(store);
    store.deleteWork = (m: RunMeta) => { if (m.id === bad.id) throw new Error('boom'); return orig(m); };
    const failed: string[] = [];
    const swept = store.sweepWork((m, e) => failed.push(`${m.id}:${e.message}`));
    assert.deepEqual(swept.map((m) => m.id), [good.id]);
    assert.deepEqual(failed, [`${bad.id}:boom`]);
    assert.deepEqual(readdirSync(store.workDir(good)), []);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('config: deleteWorkOnEnd defaults to true and rejects non-booleans', () => {
  assert.equal(parseConfig({}).deleteWorkOnEnd, true);
  assert.equal(parseConfig({ deleteWorkOnEnd: false } as never).deleteWorkOnEnd, false);
  assert.throws(() => parseConfig({ deleteWorkOnEnd: 'false' } as never), /deleteWorkOnEnd must be true or false/);
});
