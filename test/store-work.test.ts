// The run store deletes a finished run's work dir and sweeps leftovers on boot,
// but never the work dir of a running run or of one started with keepWork.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RunStore } from '../src/store.js';

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
