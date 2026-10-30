// Durability/control-flow tests. The provider capability below is a local test
// double; this suite does NOT qualify signatures, replica consensus or IPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitJournalBytes, journalBytesDigest } from '../network/journal-commit.mjs';
import { openDerivedJournal } from '../network/derived-reader/journal.mjs';
import { DERIVED_STATE_API, derivedReaderBinding, derivedReaderLayout, derivedEnrollmentFloorDigest, enrollDerivedState } from '../network/derived-reader/provider.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { ownLifecycleJournal } from '../network/deployment-journal-owner.mjs';
import { openCoverageStore } from '../network/derived-reader/coverage-store.mjs';

const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const binding = 'ab'.repeat(32), digest = 'cd'.repeat(32);
const anchor = n => ({ tier: 'l1-finalized-derived',
  base: { number: n, hash: hash(n), timestamp: 1000 + n, stateRoot: hash(n + 10), outputRoot: hash(n + 20), messagePasserStorageRoot: hash(n + 30) },
  l1: { number: n + 100, hash: hash(n + 100), timestamp: 999 + n, stateRoot: hash(n + 110) } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-durability-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true })); return dir;
}
function fixture(t) {
  const dir = directory(t), slot = 15511008, checkpointFile = path.join(dir, 'checkpoint.json');
  const bytes = JSON.stringify({ format: 'enclave-l1-checkpoint/v1', network: 'mainnet', slot, root: hash(99) });
  fs.writeFileSync(checkpointFile, bytes);
  const options = { now: () => (1606824023 + slot * 12) * 1000,
    acceptedDerivationBuilds: { [binding]: 'test only; no native invocation' },
    l1Options: { acceptedCheckpoints: { [journalBytesDigest(bytes)]: 'test only' } } };
  const config = { journalDir: path.join(dir, 'journal'), coverageDir: path.join(dir, 'cache'), runsDir: path.join(dir, 'runs'),
    native: { sha256: binding }, l1: { checkpointFile, binary: { sha256: digest } } };
  const anchorJournal = path.join(dir, 'anchor.json'), computed = derivedReaderBinding(config, options);
  const answer = { format: 'enclave-derived-enrollment-result/v1', binding: computed, mode: 'genesis', digest,
    floorDigest: derivedEnrollmentFloorDigest(null), highWater: null, priorFiles: {} };
  const calls = [];
  const enrollOptions = { ...options, anchorJournal,
    verifyEnrollment: async q => { assert.equal(q.binding, computed); assert.equal(q.floorDigest, answer.floorDigest); return answer; },
    commit: async q => { calls.push({ ...q, bytes: Buffer.from(q.bytes) }); return true; } };
  return { dir, config, options, anchorJournal, answer, calls, enrollOptions };
}
function seed(dir) {
  fs.writeFileSync(path.join(dir, 'derived-state.json'), JSON.stringify({ format: 'enclave-derived-root-journal/v1',
    binding, floor: null, entries: [], enrollment: { digest, phase: 'committed' } }));
}

test('exact bytes are copied, hashed and acknowledged strictly; false, mutation and deadlines refuse', async () => {
  const input = Buffer.from('journal');
  await commitJournalBytes(async q => {
    assert.notEqual(q.bytes, input); assert.equal(q.sha256, journalBytesDigest(input));
    assert.equal(q.file, '/private/journal'); return true;
  }, { file: '/private/journal', bytes: input });
  for (const reply of [undefined, false, { ok: true }])
    await assert.rejects(commitJournalBytes(async () => reply, { file: '/j', bytes: input }), /not durably committed/);
  await assert.rejects(commitJournalBytes(async q => { q.bytes[0] ^= 1; return true; }, { file: '/j', bytes: input }), /not durably committed/);
  let signal;
  await assert.rejects(commitJournalBytes(q => { signal = q.signal; return new Promise(() => {}); }, { file: '/j', bytes: input }, 20), /timeout/);
  assert.equal(signal.aborted, true);
});
test('derived floor is unavailable until exact byte ACK; concurrent reads and writes cannot publish', async t => {
  const dir = directory(t); seed(dir);
  const entered = deferred(), ack = deferred(); let request;
  const j = await openDerivedJournal(dir, { binding, requireCommit: true,
    commit: q => { request = q; entered.resolve(); return ack.promise; } }); t.after(() => j.close());
  const pending = j.accept(anchor(1), anchor(2)); await entered.promise;
  assert.deepEqual(request.bytes, fs.readFileSync(request.file));
  assert.equal(request.sha256, journalBytesDigest(request.bytes));
  assert.throws(() => j.read(), /pending/);
  await assert.rejects(j.accept(anchor(2), anchor(3)), /pending/);
  ack.resolve(true); await pending;
  assert.equal(j.read().floor.base.number, 2);
});
test('lost ACK fences derived journal permanently and late ACK cannot revive it', async t => {
  const dir = directory(t); seed(dir); const ack = deferred();
  const j = await openDerivedJournal(dir, { binding, requireCommit: true, commitTimeoutMs: 20, commit: () => ack.promise });
  t.after(() => j.close());
  await assert.rejects(j.accept(anchor(1), anchor(2)), /timeout/);
  ack.resolve(true); await Promise.resolve();
  assert.throws(() => j.read(), /failed/);
  await assert.rejects(j.accept(anchor(2), anchor(3)), /failed/);
});
test('close aborts pending derived commit and releases exclusion after local settlement', async t => {
  const dir = directory(t); seed(dir); const entered = deferred(), ack = deferred();
  const j = await openDerivedJournal(dir, { binding, requireCommit: true, commit: () => { entered.resolve(); return ack.promise; } });
  const accepted = j.accept(anchor(1), anchor(2)); const refused = assert.rejects(accepted, /closed/);
  await entered.promise;
  await assert.rejects(openDerivedJournal(dir, { binding }), /in use/);
  await j.close(); await refused; ack.resolve(true);
  assert.throws(() => j.read(), /closed/);
  const reopened = await openDerivedJournal(dir, { binding }); await reopened.close();
});
test('required replication cannot initialize missing or unenrolled journals', async t => {
  const dir = directory(t), file = path.join(dir, 'anchor.json'), commit = async () => true;
  assert.throws(() => openLifecycleJournal(file, { requireExisting: true }), /missing/);
  assert.throws(() => openLifecycleJournal(file, { requireCommit: true, commit }), /missing/);
  await assert.rejects(openDerivedJournal(dir, { binding, initialize: true, requireCommit: true, commit }), /enrollment/);
  const legacy = await openDerivedJournal(dir, { binding, initialize: true }); await legacy.close();
  await assert.rejects(openDerivedJournal(dir, { binding, requireCommit: true, commit }), /enrollment/);
});
test('lifecycle anchor publication waits for ACK, rows refuse replication bypass, close preserves exclusion', async t => {
  const dir = directory(t), file = path.join(dir, 'anchor.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, deployments: [], authorityAnchors: {} }));
  const entered = deferred(), ack = deferred();
  const owner = await ownLifecycleJournal(file, { requireCommit: true, commit: q => {
    assert.deepEqual(q.bytes, fs.readFileSync(file)); entered.resolve(); return ack.promise;
  } }); t.after(() => owner.close());
  assert.throws(() => owner.journal.beginAttempt(hash(1)), /cannot mutate lifecycle rows/);
  const pending = owner.journal.acceptAnchor(8453, anchor(2)); const refused = assert.rejects(pending, /closed/);
  await entered.promise;
  assert.throws(() => owner.journal.readAnchor(8453), /pending/);
  await assert.rejects(ownLifecycleJournal(file), /in use/);
  await owner.close(); await refused; ack.resolve(true);
  const again = await ownLifecycleJournal(file); await again.close();
});
test('split paths are explicit and disjoint; legacy layout remains available', () => {
  assert.deepEqual(derivedReaderLayout({ stateDir: '/state' }), { journalDir: '/state', coverageDir: '/state/coverage', runsDir: '/state/runs', split: false });
  const valid = { journalDir: '/state/journal', coverageDir: '/cache', runsDir: '/state/runs' };
  assert.equal(derivedReaderLayout(valid).split, true);
  for (const bad of [{ ...valid, stateDir: '/state' }, { ...valid, coverageDir: '/state/journal/cache' },
    { ...valid, runsDir: '/cache' }, { ...valid, runsDir: 'relative' }, { journalDir: '/journal' }])
    assert.throws(() => derivedReaderLayout(bad), /ambiguous|disjoint|absolute/);
});
test('verified genesis seeds both exact journals before opening; cached or JSON enrollment grants nothing', async t => {
  const f = fixture(t), r = await enrollDerivedState(f.config, f.enrollOptions);
  assert.equal(r.binding, f.answer.binding); assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map(q => q.file), [path.join(f.config.journalDir, 'derived-state.json'), f.anchorJournal, path.join(f.config.journalDir, 'derived-state.json')]);
  assert.equal(JSON.parse(f.calls[0].bytes).enrollment.phase, 'pending');
  assert.equal(JSON.parse(f.calls[2].bytes).enrollment.phase, 'committed');
  assert.equal(fs.existsSync(f.config.coverageDir), false); assert.equal(fs.existsSync(f.config.runsDir), false);
  assert.equal(fs.existsSync(path.join(f.config.journalDir, '.enrollment-inflight')), false);
  const j = await openDerivedJournal(f.config.journalDir, { binding: r.binding, requireCommit: true, commit: f.enrollOptions.commit });
  assert.equal(j.read().floor, null); await j.close();
  await assert.rejects(enrollDerivedState(f.config, f.enrollOptions), /committed scan/);
  const other = fixture(t);
  await assert.rejects(enrollDerivedState({ ...other.config, enrollment: other.answer }, { ...other.enrollOptions, verifyEnrollment: undefined }), /verified provider/);
});
test('provider binding, floor, previous state, rotation and recovery cannot be accepted as genesis', async t => {
  for (const wrong of [{ binding }, { floorDigest: digest }, { mode: 'rotate' }, { mode: 'recover' },
    { highWater: anchor(10) }, { format: 'json-verified' }]) {
    const f = fixture(t); Object.assign(f.answer, wrong);
    await assert.rejects(enrollDerivedState(f.config, { ...f.enrollOptions, verifyEnrollment: async () => f.answer }), /provider did not verify/);
    assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.anchorJournal), false);
  }
});
test('every failed seed ACK including final committed-phase write leaves an explicit recovery fence', async t => {
  for (const failAt of [1, 2, 3]) {
    const f = fixture(t); let calls = 0;
    await assert.rejects(enrollDerivedState(f.config, { ...f.enrollOptions, commit: async () => ++calls !== failAt }), /not durably committed/);
    assert.equal(fs.existsSync(path.join(f.config.journalDir, '.enrollment-inflight')), true);
    await assert.rejects(openDerivedJournal(f.config.journalDir, { binding: f.answer.binding }), /uncertain/);
    await assert.rejects(enrollDerivedState(f.config, f.enrollOptions), /committed scan|uncertain/);
  }
});
test('verification cancellation/deadline makes no journal and ignores late provider success', async t => {
  const f = fixture(t), entered = deferred(), response = deferred(), ac = new AbortController();
  const pending = enrollDerivedState(f.config, { ...f.enrollOptions, signal: ac.signal,
    verifyEnrollment: () => { entered.resolve(); return response.promise; } });
  const rejected = assert.rejects(pending, /cancel test/); await entered.promise;
  ac.abort(Error('cancel test')); await rejected; response.resolve(f.answer); await Promise.resolve();
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.anchorJournal), false);
  const g = fixture(t);
  await assert.rejects(enrollDerivedState(g.config, { ...g.enrollOptions, commitTimeoutMs: 20,
    verifyEnrollment: () => new Promise(() => {}) }), /verification timeout/);
  assert.equal(g.calls.length, 0);
});
test('an empty disposable coverage cache can initialize; any orphan bytes or temp manifest refuse', async t => {
  const dir = directory(t), store = await openCoverageStore(dir, { binding, initialize: true });
  assert.equal(store.status().savedFloor, null); assert.equal(store.status().verifiedToBlock, null); store.close();
  for (const name of ['manifest.json.strict.tmp', `${'1'.repeat(64)}.json`]) {
    const other = directory(t); fs.writeFileSync(path.join(other, name), '', { mode: 0o600 });
    await assert.rejects(openCoverageStore(other, { binding, initialize: true }), /manifest missing/);
    assert.equal(fs.existsSync(path.join(other, name)), true);
    assert.equal(fs.existsSync(path.join(other, 'manifest.json')), false);
  }
});
test('runtime declares the exact durable state API and exported binding', () => {
  assert.equal(DERIVED_STATE_API, 'enclave-derived-state/v1');
  assert.equal(typeof derivedReaderBinding, 'function'); assert.equal(typeof enrollDerivedState, 'function');
});
test('outcome-unknown genesis resumes only the exact committed prefix under the same enrollment', async t => {
  for (const failAt of [1, 2, 3]) for (const landed of [false, true]) {
    const f = fixture(t), committed = new Map(); let count = 0;
    const names = new Map([[path.join(f.config.journalDir, 'derived-state.json'), 'reader/derived-state.json'], [f.anchorJournal, 'bridge/anchor-journal.json']]);
    const verifyEnrollment = async q => ({ ...f.answer,
      priorFiles: Object.fromEntries([...committed].map(([name, bytes]) => [names.get(name), journalBytesDigest(bytes)])) });
    const firstCommit = async q => {
      count++;
      if (count !== failAt || landed) committed.set(q.file, Buffer.from(q.bytes));
      return count !== failAt;
    };
    await assert.rejects(enrollDerivedState(f.config, { ...f.enrollOptions, verifyEnrollment, commit: firstCommit }), /not durably committed/);
    if (!landed) {
      // Unconfirmed local bytes are not proof that a failed write was absent.
      await assert.rejects(enrollDerivedState(f.config, { ...f.enrollOptions, verifyEnrollment }), /committed scan/);
      // Stand-in for the ROLE's independently validated committed-scan reseed.
      // This file operation is test setup, never done by the KVM enrollment API.
      for (const file of names.keys()) {
        fs.rmSync(file, { force: true });
        if (committed.has(file)) fs.writeFileSync(file, committed.get(file), { mode: 0o600 });
      }
    }
    const priorCount = committed.size; let resumedWrites = 0;
    const result = await enrollDerivedState(f.config, { ...f.enrollOptions, verifyEnrollment, commit: async q => {
      resumedWrites++; committed.set(q.file, Buffer.from(q.bytes)); return true;
    } });
    assert.equal(result.enrollmentDigest, f.answer.digest);
    assert.equal(resumedWrites, 3 - (landed ? failAt : failAt - 1));
    assert.ok(priorCount <= committed.size);
    const j = await openDerivedJournal(f.config.journalDir, { binding: result.binding, requireCommit: true, commit: async () => true });
    assert.equal(j.read().floor, null); assert.deepEqual(j.read().entries, []); await j.close();
    assert.equal(fs.existsSync(path.join(f.config.journalDir, '.enrollment-inflight')), false);
  }
});
test('committed but advanced, foreign, divergent or non-prefix state is never reseeded', async t => {
  for (const kind of ['advanced', 'foreign', 'reformatted', 'anchor-only', 'unknown-file', 'missing-local']) {
    const f = fixture(t); await enrollDerivedState(f.config, f.enrollOptions);
    const readerFile = path.join(f.config.journalDir, 'derived-state.json');
    let reader = fs.readFileSync(readerFile, 'utf8'), bridge = fs.readFileSync(f.anchorJournal, 'utf8');
    if (kind === 'advanced') { const a = JSON.parse(reader); a.floor = anchor(20); reader = JSON.stringify(a); }
    if (kind === 'foreign') { const a = JSON.parse(reader); a.enrollment.digest = 'fe'.repeat(32); reader = JSON.stringify(a); }
    if (kind === 'reformatted') reader += '\n';
    fs.writeFileSync(readerFile, reader, { mode: 0o600 });
    const priorFiles = { 'reader/derived-state.json': journalBytesDigest(reader), 'bridge/anchor-journal.json': journalBytesDigest(bridge) };
    if (kind === 'anchor-only') { fs.unlinkSync(readerFile); delete priorFiles['reader/derived-state.json']; }
    if (kind === 'missing-local') fs.unlinkSync(readerFile);
    if (kind === 'unknown-file') priorFiles['reader/extra.json'] = digest;
    const before = fs.existsSync(readerFile) ? fs.readFileSync(readerFile) : null;
    let writes = 0;
    await assert.rejects(enrollDerivedState(f.config, { ...f.enrollOptions,
      verifyEnrollment: async () => ({ ...f.answer, priorFiles }), commit: async () => { writes++; return true; } }), /no floor may be reset|unknown committed|committed scan/);
    assert.equal(writes, 0);
    if (before) assert.deepEqual(fs.readFileSync(readerFile), before);
  }
});
