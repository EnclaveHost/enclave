// recovery-target.mjs offline: exact image pins (stage path for real; tampered copies refused), one frozen target added,
// the frozen helpers' own checks applied to the recovery pin, the strict attest acceptance. No network, chain or production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from '../recovery-target.mjs';
import { TARGETS } from '../attest-control.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PIN = R.RECOVERY.measurement, KEY = '0x8853f452533e2f05eb4c9289f77dbeacc316d1ed';
const STAGE = R.RECOVERY.images[1];

test('frozen helpers and the real approved stage image pass; the production path is not required to exist yet', () => {
  R.checkFrozen();
  assert.equal(R.checkRecoveryImage(), fs.existsSync(R.RECOVERY.images[0]) ? R.RECOVERY.images[0] : STAGE);
  assert.equal(fs.readFileSync(path.join(STAGE, 'MEASUREMENT'), 'utf8').trim(), PIN);
});

function fake(dir, over = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = { MEASUREMENT: PIN + '\n', 'manifest.json': '{}', 'initramfs.cpio.gz': 'i', vmlinuz: 'k', cmdline: 'c', ...over };
  for (const [f, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), b);
  return Object.fromEntries(Object.entries(files).map(([f, b]) => [f, sha(Buffer.from(b))]));
}

test('image pins: every present location must match all five files and name the pin', () => {
  const base = fs.mkdtempSync(path.join(HERE, '..', '.recovery-test-')); try {
    const good = path.join(base, 'good'), bad = path.join(base, 'bad'), none = path.join(base, 'none');
    const files = fake(good); fake(bad, { 'initramfs.cpio.gz': 'j' });
    const t = (images, over = {}) => ({ ...R.RECOVERY, images, files, ...over });
    assert.equal(R.checkRecoveryImage(t([none, good])), good);
    assert.throws(() => R.checkRecoveryImage(t([none])), /no recovery image/);
    assert.throws(() => R.checkRecoveryImage(t([good, bad])), /initramfs.cpio.gz is not the approved file/);   // prod copy differs from stage
    assert.throws(() => R.checkRecoveryImage(t([bad, good])), /not the approved file/);
    const other = path.join(base, 'other'), f2 = fake(other, { MEASUREMENT: TARGETS.new.measurement + '\n' });
    assert.throws(() => R.checkRecoveryImage({ ...R.RECOVERY, images: [other], files: f2 }), /does not name the pin/);
  } finally { fs.rmSync(base, { recursive: true }); }
});

test('exactly one frozen target is added; a conflicting one refuses; current/new untouched', () => {
  const before = JSON.stringify({ c: TARGETS.current, n: TARGETS.new });
  const e = R.installTarget(STAGE);
  assert.equal(e.measurement, PIN); assert.ok(Object.isFrozen(e)); assert.equal(R.installTarget(STAGE), e);
  assert.throws(() => R.installTarget('/elsewhere'), /different recovery target/);
  assert.deepEqual(Object.keys(TARGETS).sort(), ['current', 'new', 'recovery']);
  assert.equal(JSON.stringify({ c: TARGETS.current, n: TARGETS.new }), before);
});

test('attest: the frozen probe is pinned to the recovery measurement; acceptance is strict', async () => {
  R.installTarget(STAGE);
  const fetchImpl = async () => ({ status: 503, text: async () => 'down' });
  const { verdict } = await R.attest({ deps: { fetchImpl, now: Date.parse('2026-10-23T22:30:00Z') } });
  assert.equal(verdict.target, 'recovery'); assert.equal(verdict.expectedMeasurement, PIN);
  assert.equal(verdict.pass, false); assert.equal(verdict.accepted, false);
  const ok = { pass: true, target: 'recovery', expectedMeasurement: PIN, observedMeasurement: PIN };
  assert.equal(R.attestAccepted(ok), true);
  for (const over of [{ pass: false }, { target: 'new' }, { observedMeasurement: TARGETS.new.measurement }, { expectedMeasurement: TARGETS.current.measurement }, { observedMeasurement: null }])
    assert.equal(R.attestAccepted({ ...ok, ...over }), false, JSON.stringify(over));
});

test('proofkey: the frozen helper checks the stored document against the RECOVERY pin; limits stay explicit', async () => {
  R.installTarget(STAGE);
  const spki = crypto.randomBytes(91), T = sha(spki);
  const report = (meas) => { const r = Buffer.alloc(0x4a0); crypto.createHash('sha256').update(spki).digest().copy(r, 0x50); Buffer.from(meas, 'hex').copy(r, 0x90); return r; };
  const probe = (meas) => async ({ target }) => { assert.equal(target, 'recovery');
    return { verdict: { pass: true, status: 'verified', observedMeasurement: meas, transportKeySha256: T, failedChecks: [], unavailable: [] }, raw: {} }; };
  const sup = (meas) => async () => ({ status: 200, text: async () => JSON.stringify({ proofKey: { address: KEY, keySource: 'in-enclave' }, sessionKey: { kid: 'k' },
    enclave: { attestationDocument: { format: 'sev-snp-guest-metal-v1', transportKey: spki.toString('base64'), body: report(meas).toString('base64') } } }) });
  const registry = (proofKey) => async () => ({ endpoint: 'https://api.enclave.host/t/metal0', operator: '0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab', active: true, proofKey });
  const go = (deps) => R.proofkey({ expectProofKey: KEY, deps: { now: '2026-10-23T22:30:00Z', ...deps } }).then((r) => r.verdict);
  let v = await go({ probe: probe(PIN), fetchImpl: sup(PIN), registry: registry(KEY) });
  assert.equal(v.status, 'verified-legacy'); assert.equal(v.expectedMeasurement, PIN); assert.equal(v.wrapper, 'recovery-target/1');
  assert.match(v.parts['B supervisor'], /not hardware-bound/); assert.ok(v.limits.some((l) => /not bound into any SNP report_data/.test(l)));
  v = await go({ probe: probe(PIN), fetchImpl: sup(PIN), registry: registry('0x' + '11'.repeat(20)) });
  assert.equal(v.status, 'pending-registry'); assert.equal(v.exitCode, 2);
  v = await go({ probe: probe(TARGETS.new.measurement), fetchImpl: sup(PIN), registry: registry(KEY) });   // the ee5df6b8 image is not recovery
  assert.equal(v.status, 'rejected');
  v = await go({ probe: probe(PIN), fetchImpl: sup(TARGETS.new.measurement), registry: registry(KEY) });
  assert.equal(v.status, 'rejected'); assert.match(v.reasons.join(), /another measurement/);
});
