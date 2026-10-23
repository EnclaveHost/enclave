// verify-recipient-proofkey.mjs with stubs (no network, no chain, no production): every part must pass for
// "verified-legacy"; a registry key not yet this boot's is PENDING; any other mismatch is REJECTED; a failed read is UNKNOWN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as V from '../verify-recipient-proofkey.mjs';
import { TARGETS } from '../attest-control.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const KEY = '0x8853f452533e2f05eb4c9289f77dbeacc316d1ed', OLD_KEY = '0x' + '11'.repeat(20);
const SPKI = crypto.randomBytes(91), CHIP = 'cd'.repeat(64);
const M = { current: TARGETS.current.measurement, new: TARGETS.new.measurement };
function report(meas, spki = SPKI) { const r = Buffer.alloc(0x4a0); crypto.createHash('sha256').update(spki).digest().copy(r, 0x50); Buffer.from(meas, 'hex').copy(r, 0x90); Buffer.from(CHIP, 'hex').copy(r, 0x1a0); return r; }
const probeOk = (target, over = {}) => async () => ({ verdict: { pass: true, status: 'verified', required: { binding: 'PASS' }, observedMeasurement: M[target],
  nonce: 'aa'.repeat(32), transportKeySha256: sha(SPKI), rawSha256: 'bb'.repeat(32), unavailable: ['x'], failedChecks: [], ...over }, raw: { text: 'RAW-QUOTE-' + CHIP } });
const supervisor = (over = {}, doc = {}) => async () => ({ status: 200, text: async () => JSON.stringify({
  proofKey: { address: KEY.toUpperCase().replace('0X', '0x'), keySource: 'in-enclave' }, sessionKey: { kid: 'kid1' },
  enclave: { attestationDocument: { format: 'sev-snp-guest-metal-v1', transportKey: SPKI.toString('base64'), body: report(M.current).toString('base64'), ...doc } }, ...over }) });
const reg = (over = {}) => async (id) => { assert.equal(id, V.REGISTRY_ID); return { endpoint: V.ENDPOINT, operator: V.OPERATOR, active: true, proofKey: KEY, measurement: '0x' + '00'.repeat(32), block: { number: '1' }, ...over }; };
const run = (deps, target = 'current') => V.run({ target, expectProofKey: KEY, deps: { now: '2026-10-23T22:00:00Z', ...deps } }).then((r) => r.verdict);

test('all three parts match: verified-legacy (never plain "verified"), exit 0', async () => {
  const v = await run({ probe: probeOk('current'), fetchImpl: supervisor(), registry: reg() });
  assert.equal(v.status, 'verified-legacy'); assert.equal(v.exitCode, 0); assert.equal(v.parts['C registry'], 'MATCH');
  assert.match(v.parts['B supervisor'], /not hardware-bound/); assert.ok(v.limits.some((l) => /NOT applicable/.test(l)));
  assert.equal(v.transportKeySha256, sha(SPKI)); assert.match(v.servedDocumentSha256, /^[0-9a-f]{64}$/);
});

test('registry still names the previous boot\'s key: pending-registry, exit 2', async () => {
  const v = await run({ probe: probeOk('current'), fetchImpl: supervisor(), registry: reg({ proofKey: OLD_KEY }) });
  assert.equal(v.status, 'pending-registry'); assert.equal(v.exitCode, 2); assert.equal(v.parts['C registry'], 'PENDING');
});

test('every other mismatch is REJECTED', async () => {
  const other = crypto.randomBytes(91);
  const cases = [
    { probe: probeOk('current', { pass: false, status: 'rejected', failedChecks: ['binding'] }) },
    { probe: probeOk('current', { observedMeasurement: M.new }) },
    { fetchImpl: supervisor({ proofKey: { address: OLD_KEY, keySource: 'in-enclave' } }) },
    { fetchImpl: supervisor({ proofKey: { address: KEY, keySource: 'operator' } }) },
    { fetchImpl: supervisor({ sessionKey: null }) },
    { fetchImpl: supervisor({}, { transportKey: other.toString('base64') }) },
    { fetchImpl: supervisor({}, { body: report(M.new).toString('base64') }) },
    { fetchImpl: supervisor({}, { body: report(M.current, other).toString('base64') }) },
    { fetchImpl: supervisor({}, { format: 'sev-snp-guest-domain-v1' }) },
    { fetchImpl: async () => ({ status: 404, text: async () => '{}' }) },
    { registry: reg({ operator: '0x' + '22'.repeat(20) }) },
    { registry: reg({ active: false }) },
    { registry: reg({ endpoint: 'https://api.enclave.host/t/metal1' }) },
    { registry: reg({ operator: '0x' + '00'.repeat(20) }) },
  ];
  for (const c of cases) {
    const v = await run({ probe: probeOk('current'), fetchImpl: supervisor(), registry: reg(), ...c });
    assert.equal(v.status, 'rejected', JSON.stringify(Object.keys(c)) + ' ' + v.reasons.join('|')); assert.equal(v.exitCode, 1);
  }
});

test('failed reads are UNKNOWN, never pass or pending', async () => {
  const cases = [{ probe: async () => { throw new Error('KDS 429'); } }, { probe: probeOk('current', { status: 'unavailable', pass: false, reasons: ['relay timeout'] }) },
                 { fetchImpl: async () => { throw new Error('ECONNRESET'); } }, { fetchImpl: async () => ({ status: 503, text: async () => '' }) },
                 { registry: async () => { throw new Error('quorum disagreed'); } }];
  for (const c of cases) {
    const v = await run({ probe: probeOk('current'), fetchImpl: supervisor(), registry: reg(), ...c });
    assert.equal(v.status, 'unknown', v.reasons.join('|')); assert.equal(v.exitCode, 1);
  }
});

test('inputs are validated and the public output carries no chip id or raw quote', async () => {
  await assert.rejects(() => V.run({ target: 'current', expectProofKey: '0x123' }), /expect-proof-key/);
  await assert.rejects(() => V.run({ target: 'other', expectProofKey: KEY }), /target/);
  const { verdict, raw } = await V.run({ target: 'current', expectProofKey: KEY, deps: { probe: probeOk('current'), fetchImpl: supervisor(), registry: reg(), now: '2026-10-23T22:00:00Z' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-')); const f = V.persist(verdict, raw, dir);
  const pub = fs.readFileSync(f.pub, 'utf8');
  assert.ok(!pub.includes(CHIP) && !pub.includes('RAW-QUOTE')); assert.ok(fs.readFileSync(f.rawFile, 'utf8').includes('RAW-QUOTE'));
  assert.equal(fs.statSync(f.rawFile).mode & 0o777, 0o600); assert.equal(JSON.parse(pub).rawSha256, sha(fs.readFileSync(f.rawFile)));
});
