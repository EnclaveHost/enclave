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
import { READER_FILE, BRIDGE_FILE, dominantEnrollmentFloor, enrollmentManifest, enrollmentManifestDigest } from '../network/derived-reader/enrollment.mjs';

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
    await assert.rejects(enrollDerivedState(f.config, { ...f.enrollOptions, verifyEnrollment: async () => f.answer }), /provider did not verify|authenticated previous|recovery requires/);
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
      verifyEnrollment: async () => ({ ...f.answer, priorFiles }), commit: async () => { writes++; return true; } }), /no floor may be reset|invalid original committed|committed scan|provider did not verify/);
    assert.equal(writes, 0);
    if (before) assert.deepEqual(fs.readFileSync(readerFile), before);
  }
});

async function rebindFixture(t, mode, { missing = [], bridgeNumber = 5 } = {}) {
  const f = fixture(t); await enrollDerivedState(f.config, f.enrollOptions);
  const readerFile = path.join(f.config.journalDir, 'derived-state.json');
  const j = await openDerivedJournal(f.config.journalDir, { binding: f.answer.binding, requireCommit: true, commit: async () => true });
  await j.accept(anchor(1), anchor(8)); await j.close();
  const bridge = openLifecycleJournal(f.anchorJournal, { requireCommit: true, commit: async () => true });
  await bridge.acceptAnchor(8453, anchor(bridgeNumber)); bridge.close();
  const paths = { [READER_FILE]: readerFile, [BRIDGE_FILE]: f.anchorJournal };
  for (const rel of missing) fs.unlinkSync(paths[rel]);
  const current = () => Object.fromEntries(Object.entries(paths).filter(([, p]) => fs.existsSync(p)).map(([rel, p]) => [rel, fs.readFileSync(p, 'utf8')]));
  const original = current(), committed = new Map(Object.entries(original)), originalManifest = enrollmentManifest(original);
  const config = { ...f.config, intermediateBlockInterval: 2 };
  const floor = mode === 'recover' ? anchor(12) : dominantEnrollmentFloor(
    original[READER_FILE] ? JSON.parse(original[READER_FILE]).floor : null,
    original[BRIDGE_FILE] ? JSON.parse(original[BRIDGE_FILE]).authorityAnchors['8453'] : null);
  const answer = { ...f.answer, mode, binding: derivedReaderBinding(config, f.options), digest: 'ef'.repeat(32),
    previousBinding: f.answer.binding, previousEnrollmentDigest: f.answer.digest,
    stateDigest: enrollmentManifestDigest(originalManifest), floorDigest: derivedEnrollmentFloorDigest(floor),
    highWater: mode === 'recover' ? floor : null };
  let writes = 0;
  const verifyEnrollment = async q => {
    assert.equal(q.binding, answer.binding); assert.equal(q.floorDigest, answer.floorDigest);
    return { ...answer, priorFiles: enrollmentManifest(Object.fromEntries(committed)) };
  };
  const commit = async q => {
    const rel = Object.keys(paths).find(k => paths[k] === q.file); assert.ok(rel);
    writes++; committed.set(rel, q.bytes.toString('utf8')); return true;
  };
  const options = { ...f.options, anchorJournal: f.anchorJournal, verifyEnrollment, commit,
    enrollmentFloor: mode === 'recover' ? floor : null };
  return { ...f, readerFile, paths, config, options, answer, floor, originalManifest, current, committed,
    writes: () => writes, verifyEnrollment, commit };
}
test('rotation carries the stronger reader or bridge floor and links the signed original state', async t => {
  for (const bridgeNumber of [5, 10]) {
    const f = await rebindFixture(t, 'rotate', { bridgeNumber });
    const result = await enrollDerivedState(f.config, f.options);
    const reader = JSON.parse(fs.readFileSync(f.readerFile)), bridge = JSON.parse(fs.readFileSync(f.anchorJournal));
    assert.equal(reader.binding, result.binding); assert.deepEqual(reader.floor, anchor(Math.max(8, bridgeNumber)));
    assert.deepEqual(bridge.authorityAnchors['8453'], reader.floor);
    assert.deepEqual(reader.entries, []);
    assert.deepEqual(reader.enrollment.previousManifest, f.originalManifest);
    assert.equal(reader.enrollment.stateDigest, f.answer.stateDigest);
    assert.equal(reader.enrollment.previousEnrollmentDigest, f.answer.previousEnrollmentDigest);
    const j = await openDerivedJournal(f.config.journalDir, { binding: result.binding, requireCommit: true, commit: f.commit });
    await assert.rejects(j.accept(anchor(1), anchor(7)), /rollback/); await j.close();
    assert.equal(derivedReaderBinding({ ...f.config, coverageDir: f.config.coverageDir + '/by-binding' }, f.options), result.binding);
  }
});
test('recover requires the signed high-water and raises both journals above both saved floors', async t => {
  const f = await rebindFixture(t, 'recover', { bridgeNumber: 10 });
  await enrollDerivedState(f.config, f.options);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.readerFile)).floor, anchor(12));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.anchorJournal)).authorityAnchors['8453'], anchor(12));
  const g = await rebindFixture(t, 'recover', { bridgeNumber: 10 });
  await assert.rejects(enrollDerivedState(g.config, { ...g.options, enrollmentFloor: anchor(9) }), /below a saved floor/);
  assert.equal(g.writes(), 0);
  await assert.rejects(enrollDerivedState(g.config, { ...g.options, enrollmentFloor: null,
    verifyEnrollment: async q => ({ ...g.answer, floorDigest: q.floorDigest, priorFiles: enrollmentManifest(g.current()) }) }), /signed retained high-water/);
});
test('same-height field conflicts and incomparable Base/L1 floors refuse before enrollment writes', async t => {
  const a = anchor(8);
  for (const [chain, fields] of [['base', ['hash', 'stateRoot', 'timestamp', 'outputRoot', 'messagePasserStorageRoot']], ['l1', ['hash', 'stateRoot', 'timestamp']]]) {
    for (const field of fields) {
      const b = structuredClone(a); b[chain][field] = field === 'timestamp' ? a[chain][field] + 1 : hash(999);
      assert.throws(() => dominantEnrollmentFloor(a, b), /same-height/);
    }
  }
  const b = anchor(9); b.l1 = anchor(7).l1;
  assert.throws(() => dominantEnrollmentFloor(a, b), /incomparable/);
  const f = await rebindFixture(t, 'recover');
  const bad = anchor(12); bad.base = { ...anchor(8).base, stateRoot: hash(999) };
  await assert.rejects(enrollDerivedState(f.config, { ...f.options, enrollmentFloor: bad }), /same-height/);
  assert.equal(f.writes(), 0);
});
test('wrong previous binding, enrollment, manifest, signed floor or high-water cannot authorize rebind', async t => {
  for (const mode of ['rotate', 'recover']) for (const wrong of [
    { previousBinding: '91'.repeat(32) }, { previousEnrollmentDigest: '92'.repeat(32) },
    { stateDigest: '93'.repeat(32) }, { floorDigest: '94'.repeat(32) }, { highWater: anchor(99) },
  ]) {
    const f = await rebindFixture(t, mode), before = f.current();
    await assert.rejects(enrollDerivedState(f.config, { ...f.options,
      verifyEnrollment: async () => ({ ...f.answer, ...wrong, priorFiles: enrollmentManifest(f.current()) }) }),
      /previous enrollment|prior state manifest|verify this floor|rotation cannot|signed retained high-water/);
    assert.equal(f.writes(), 0); assert.deepEqual(f.current(), before);
  }
});
test('rotation and recovery reconcile every lost-ACK prefix without reducing either floor', async t => {
  for (const mode of ['rotate', 'recover']) for (const failAt of [1, 2, 3]) for (const landed of [false, true]) {
    const f = await rebindFixture(t, mode); let calls = 0;
    await assert.rejects(enrollDerivedState(f.config, { ...f.options, commit: async q => {
      calls++; if (calls !== failAt || landed) await f.commit(q);
      return calls !== failAt;
    } }), /not durably committed/);
    await assert.rejects(openDerivedJournal(f.config.journalDir, { binding: f.answer.binding }), /uncertain/);
    if (!landed) {
      await assert.rejects(enrollDerivedState(f.config, f.options), /committed scan/);
      // Reconcile RAM from the independent committed scan, as the ROLE must do.
      for (const [rel, p] of Object.entries(f.paths)) {
        fs.rmSync(p, { force: true });
        if (f.committed.has(rel)) fs.writeFileSync(p, f.committed.get(rel), { mode: 0o600 });
      }
    }
    const beforeWrites = f.writes(); await enrollDerivedState(f.config, f.options);
    assert.equal(f.writes() - beforeWrites, 3 - (landed ? failAt : failAt - 1));
    const reader = JSON.parse(fs.readFileSync(f.readerFile)), bridge = JSON.parse(fs.readFileSync(f.anchorJournal));
    assert.deepEqual(reader.floor, f.floor); assert.deepEqual(bridge.authorityAnchors['8453'], f.floor);
    assert.equal(reader.enrollment.phase, 'committed');
    assert.deepEqual(reader.enrollment.previousManifest, f.originalManifest);
  }
});
test('signed recover can restore missing archive journals above retained high-water; rotate cannot', async t => {
  for (const missing of [[READER_FILE], [BRIDGE_FILE], [READER_FILE, BRIDGE_FILE]]) {
    const f = await rebindFixture(t, 'recover', { missing }); await enrollDerivedState(f.config, f.options);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.readerFile)).floor, anchor(12));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.anchorJournal)).authorityAnchors['8453'], anchor(12));
    const g = await rebindFixture(t, 'rotate', { missing });
    await assert.rejects(enrollDerivedState(g.config, g.options), /requires both complete/);
    assert.equal(g.writes(), 0);
  }
});
test('advanced new progress and altered pending original manifest cannot replay an older rebind', async t => {
  const f = await rebindFixture(t, 'recover'); await enrollDerivedState(f.config, f.options);
  const j = await openDerivedJournal(f.config.journalDir, { binding: f.answer.binding, requireCommit: true, commit: f.commit });
  await j.accept(anchor(12), anchor(13)); await j.close();
  const before = f.current();
  await assert.rejects(enrollDerivedState(f.config, f.options), /below a saved floor/);
  assert.deepEqual(f.current(), before);
  const g = await rebindFixture(t, 'rotate'); let calls = 0;
  await assert.rejects(enrollDerivedState(g.config, { ...g.options, commit: async q => {
    await g.commit(q); return ++calls < 1;
  } }), /not durably committed/);
  const pending = JSON.parse(fs.readFileSync(g.readerFile)); pending.enrollment.previousManifest[BRIDGE_FILE] = '88'.repeat(32);
  fs.writeFileSync(g.readerFile, JSON.stringify(pending)); g.committed.set(READER_FILE, JSON.stringify(pending));
  const beforeTamper = g.current();
  await assert.rejects(enrollDerivedState(g.config, g.options), /authenticated prior state/);
  assert.deepEqual(g.current(), beforeTamper);
});
