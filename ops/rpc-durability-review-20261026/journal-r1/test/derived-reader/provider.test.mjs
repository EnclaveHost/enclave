import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { sha256File } from '../../network/derived-reader/process.mjs';
import { createDerivedProvider, startDerivedReader } from '../../network/derived-reader/provider.mjs';
import { openDerivedJournal } from '../../network/derived-reader/journal.mjs';
import { readCheckpoint } from '../../network/derived-reader/l1-runtime.mjs';
import { setup, nativeResult, header } from './helpers.mjs';
async function provider(t, f) {
  f.journal = await openDerivedJournal(f.directory, { binding: 'a'.repeat(64), initialize: true });
  t.after(() => f.journal.close());
  const options = { l1: f.l1, journal: f.journal, executable: f.native, workDir: f.directory, now: () => f.now,
    bootstrap: async () => { f.bootstraps = (f.bootstraps || 0) + 1; return f.agreed; },
    base: async () => f.candidate };
  f.options = options;
  const p = await createDerivedProvider(options); t.after(() => p.close()); return p;
}
test('owned L1 process + bounded native transport publishes only after exact result binding and durable acceptance', async t => {
  const f = await setup(t), p = await provider(t, f);
  await assert.rejects(p.readAnchor(), /no locally derived/);
  const ticket = await p.prepare({ blockNumber: 101, rollupConfigTemplate: { l2_chain_id: 8453 } });
  assert.equal(f.journal.read().floor, null);
  const result = await p.submit({ ticket: ticket.ticket, witness: Buffer.from(JSON.stringify(nativeResult(ticket, f.candidate))) });
  assert.equal(result.status, 'verified');
  assert.deepEqual(await p.readAnchor(), f.journal.read().floor);
  assert.equal(f.journal.read().entries[0].agreedRoot, f.agreed.base.outputRoot);
  await assert.rejects(p.submit({ ticket: ticket.ticket, witness: Buffer.from('{}') }), /unknown/);
});
test('forged root, wrong executed header, and foreign proof tickets cannot grant authority', async t => {
  const f = await setup(t), p = await provider(t, f);
  const ticket = await p.prepare({ blockNumber: 101, rollupConfigTemplate: { l2_chain_id: 8453 } });
  await assert.rejects(p.submit({ ticket: '0'.repeat(64), witness: Buffer.from('{}') }), /unknown/);
  const wrong = nativeResult(ticket, f.candidate); wrong.base.timestamp++;
  await assert.rejects(p.submit({ ticket: ticket.ticket, witness: Buffer.from(JSON.stringify(wrong)) }), /executed header/);
  assert.equal(f.journal.read().floor, null);
  await assert.rejects(p.readAnchor(), /no locally derived/);
  const retry = await p.prepare({ blockNumber: 101, rollupConfigTemplate: { l2_chain_id: 8453 } });
  const forged = nativeResult(retry, f.candidate); forged.l2OutputRoot = `0x${'ff'.repeat(32)}`;
  await assert.rejects(p.submit({ ticket: retry.ticket, witness: Buffer.from(JSON.stringify(forged)) }), /l2OutputRoot/);
});
test('restart reauthenticates bootstrap and rederives instead of trusting a saved root', async t => {
  const f = await setup(t), p = await provider(t, f);
  const ticket = await p.prepare({ blockNumber: 101, rollupConfigTemplate: { l2_chain_id: 8453 } });
  await p.submit({ ticket: ticket.ticket, witness: Buffer.from(JSON.stringify(nativeResult(ticket, f.candidate))) });
  await p.close();
  const recovered = await createDerivedProvider(f.options); t.after(() => recovered.close());
  await assert.rejects(recovered.readAnchor(), /no locally derived/);
  await assert.rejects(recovered.prepare({ blockNumber: 102, rollupConfigTemplate: { l2_chain_id: 8453 } }), /saved floor exactly/);
  const again = await recovered.prepare({ blockNumber: 101, rollupConfigTemplate: { l2_chain_id: 8453 } });
  assert.equal(f.bootstraps, 2);
  await recovered.submit({ ticket: again.ticket, witness: Buffer.from(JSON.stringify(nativeResult(again, f.candidate))) });
  assert.equal((await recovered.readAnchor()).base.number, 101);
});
test('an uncertain journal write fences the previous in-memory anchor too', async t => {
  const f = await setup(t), p = await provider(t, f);
  const first = await p.prepare({ blockNumber: 101, rollupConfigTemplate: { l2_chain_id: 8453 } });
  await p.submit({ ticket: first.ticket, witness: Buffer.from(JSON.stringify(nativeResult(first, f.candidate))) });
  f.candidate = header(102, Math.floor(f.now / 1000) - 1);
  const next = await p.prepare({ blockNumber: 102, rollupConfigTemplate: { l2_chain_id: 8453 } });
  fs.mkdirSync(path.join(f.directory, 'derived-state.json.strict.tmp'));
  await assert.rejects(p.submit({ ticket: next.ticket, witness: Buffer.from(JSON.stringify(nativeResult(next, f.candidate))) }), /EISDIR/);
  await assert.rejects(p.readAnchor(), /closed|failed/);
});
test('stale derived blocks and a changed finalized L1 header refuse without refreshing timestamps', async t => {
  const f = await setup(t), p = await provider(t, f);
  const ticket = await p.prepare({ blockNumber: 101, rollupConfigTemplate: { l2_chain_id: 8453 } });
  await p.submit({ ticket: ticket.ticket, witness: Buffer.from(JSON.stringify(nativeResult(ticket, f.candidate))) });
  f.l1Header.hash = `0x${'ab'.repeat(32)}`; f.save();
  await assert.rejects(p.readAnchor(), /no longer matches/);
  f.l1Header.hash = f.head.hash; f.save(); f.now += 1801000;
  await assert.rejects(p.readAnchor(), /stale/);
});
test('an untrusted header source cannot escape the requested block/range or replace owner process authority', async t => {
  const f = await setup(t), p = await provider(t, f);
  f.candidate = header(110, Math.floor(f.now / 1000) - 1);
  await assert.rejects(p.prepare({ blockNumber: 101, rollupConfigTemplate: { l2_chain_id: 8453 } }), /another block/);
  await assert.rejects(createDerivedProvider({ ...f.options, l1: { request: f.l1.request } }), /owned local/);
  await f.l1.close();
  await assert.rejects(p.prepare({ blockNumber: 101, rollupConfigTemplate: { l2_chain_id: 8453 } }), /closed/);
});
test('startup refuses unreviewed native binaries, foreign bootstrap policy and checkpoint records', async t => {
  const f = await setup(t);
  await assert.rejects(startDerivedReader({ stateDir: f.directory, native: { sha256: '1'.repeat(64) }, l1: {} }), /native/);
  await assert.rejects(startDerivedReader({ stateDir: f.directory, a1Config: { pinBy: 'hash' } }), /reviewed ASR/);
  assert.throws(() => readCheckpoint(path.join(f.directory, 'checkpoint.json')), /not reviewed/);
  const bytes = fs.readFileSync(path.join(f.directory, 'checkpoint.json')); assert.ok(bytes.length);
});
test('full runtime enrollment owns private children, closes cleanly, and binds checkpoint rotation', async t => {
  const f = await setup(t); await f.l1.close();
  const digest = await sha256File(f.native), stateDir = path.join(f.directory, 'state');
  const config = { stateDir, native: { path: f.native, sha256: digest }, l1: f.l1Config, baseUrl: 'http://127.0.0.1:1' };
  // Overrides are test-only local capabilities, never fields accepted from config JSON.
  const options = { now: () => f.now, l1Options: f.l1Options, acceptedDerivationBuilds: { [digest]: 'fixture only' } };
  await assert.rejects(startDerivedReader(config, options), /missing/);
  const reader = await startDerivedReader({ ...config, initializeState: true }, options);
  t.after(() => reader.close());
  assert.equal(reader.status().hasDerivedAnchor, false);
  await assert.rejects(reader.readAnchor(), /no locally derived/);
  await reader.close();
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'runs')), ['runs.lock']);
  fs.appendFileSync(f.l1Config.checkpointFile, '\n');
  const next = createHash('sha256').update(fs.readFileSync(f.l1Config.checkpointFile)).digest('hex');
  options.l1Options = { ...f.l1Options, acceptedCheckpoints: { [next]: 'rotated fixture' } };
  await assert.rejects(startDerivedReader(config, options), /binding/);
});
test('native result awaits replication and rechecks freshness before publishing', async t => {
  const f = await setup(t);
  let ack, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const journal = await openDerivedJournal(f.directory, { binding: 'a'.repeat(64), initialize: true,
    commit: () => { entered(); return new Promise(resolve => { ack = resolve; }); } });
  t.after(() => journal.close());
  const p = await createDerivedProvider({ l1: f.l1, journal, executable: f.native, workDir: f.directory,
    now: () => f.now, bootstrap: async () => f.agreed, base: async () => f.candidate, maxAnchorAgeSec: 120 });
  t.after(() => p.close());
  const ticket = await p.prepare({ blockNumber: 101, rollupConfigTemplate: { l2_chain_id: 8453 } });
  let returned = false;
  const pending = p.submit({ ticket: ticket.ticket, witness: Buffer.from(JSON.stringify(nativeResult(ticket, f.candidate))) })
    .then(value => { returned = true; return value; });
  await reached; assert.equal(returned, false);
  await assert.rejects(p.readAnchor(), /pending|busy/);
  f.now += 121000; ack(true);
  const result = await pending;
  assert.equal(result.status, 'recovering'); assert.equal(result.verifiedThrough, 101);
  assert.equal(journal.read().floor.base.number, 101);
  await assert.rejects(p.readAnchor(), /no locally derived/);
});
test('L1 consistency is rechecked after an exact journal ACK', async t => {
  const f = await setup(t);
  const journal = await openDerivedJournal(f.directory, { binding: 'a'.repeat(64), initialize: true,
    commit: async () => { f.l1Header.hash = `0x${'ab'.repeat(32)}`; f.save(); return true; } });
  t.after(() => journal.close());
  const p = await createDerivedProvider({ l1: f.l1, journal, executable: f.native, workDir: f.directory,
    now: () => f.now, bootstrap: async () => f.agreed, base: async () => f.candidate });
  t.after(() => p.close());
  const ticket = await p.prepare({ blockNumber: 101, rollupConfigTemplate: { l2_chain_id: 8453 } });
  await assert.rejects(p.submit({ ticket: ticket.ticket, witness: Buffer.from(JSON.stringify(nativeResult(ticket, f.candidate))) }), /no longer matches/);
  await assert.rejects(p.readAnchor(), /closed/);
});
