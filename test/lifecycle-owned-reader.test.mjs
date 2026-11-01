// Real owned Linux journal and bridge; provider startup/native reader are inert doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { ownLifecycleJournal } from '../network/deployment-journal-owner.mjs';
const moduleUrl = new URL('../network/derived-reader/lifecycle.mjs', import.meta.url);
const key = '__lifecycleOwnedReaderTest';
const hooks = registerHooks({ resolve(spec, ctx, next) {
  if (ctx.parentURL === moduleUrl.href && spec === './provider.mjs') return {
    url: 'data:text/javascript,' + encodeURIComponent(`export const startDerivedReader=(...args)=>globalThis.${key}(...args)`), shortCircuit: true };
  return next(spec, ctx);
} });
const { startDerivedLifecycleReader } = await import(moduleUrl.href);
test.after(() => { hooks.deregister(); delete globalThis[key]; });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 1));
  assert.ok(check());
}
async function owner(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-reader-')), file = path.join(dir, 'journal.json');
  const handle = await ownLifecycleJournal(file, { initialize: true });
  t.after(async () => { await handle.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { handle, file };
}
test('raw journal is refused before reader startup', async () => {
  let starts = 0; globalThis[key] = async () => { starts++; };
  await assert.rejects(startDerivedLifecycleReader({}, { journal: {} }), /owned lifecycle journal/);
  assert.equal(starts, 0);
});
test('owner close during startup waits for the exact late reader and never publishes it', async t => {
  const { handle, file } = await owner(t), startup = deferred(), death = deferred();
  let signal, closes = 0;
  globalThis[key] = async (_config, opts) => { signal = opts.signal; return startup.promise; };
  const start = startDerivedLifecycleReader({}, { journalOwner: handle });
  const rejected = assert.rejects(start, /closed during startup/);
  const closing = handle.close();
  assert.equal(signal.aborted, true);
  await assert.rejects(ownLifecycleJournal(file), /in use/);
  startup.resolve({ close: async () => { closes++; await death.promise; } });
  await until(() => closes === 1);
  await assert.rejects(ownLifecycleJournal(file), /in use/);
  death.resolve(); await rejected;
  assert.equal((await closing).released, true); assert.equal(closes, 1);
});
test('service close and owner release share reader cleanup and wait for a raw bridge read', async t => {
  const { handle, file } = await owner(t), raw = deferred(); let read = false, closes = 0;
  globalThis[key] = async () => ({ readAnchor: async () => { read = true; return raw.promise; }, close: async () => { closes++; } });
  const service = await startDerivedLifecycleReader({}, { journalOwner: handle, verifier: { request: async () => { throw Error('unused'); } } });
  const operation = assert.rejects(service.snapshot(() => true), /closed/);
  await until(() => read);
  const closing = handle.close(); await operation;
  assert.equal(service.close(), service.close());
  await assert.rejects(ownLifecycleJournal(file), /in use/);
  raw.resolve(null); assert.equal((await closing).released, true);
  assert.equal(closes, 1);
  await assert.rejects(service.snapshot(() => true), /closed/);
});
