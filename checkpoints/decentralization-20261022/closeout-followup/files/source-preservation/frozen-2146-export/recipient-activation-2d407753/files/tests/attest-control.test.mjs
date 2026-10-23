// Offline tests of attest-control.mjs through the REAL verifier (verifier/consumer.mjs at a6b1378c). The only authentic Turin
// report on hand is the M4a domain document (test/fixtures/verifier/turin-m4a, public, AMD-signed); there is no authentic
// metal-format control document offline, so a live PASS cannot be shown here - root's fresh run is the proof. What these show:
// the AMD signature/chain/CRL/TCB/measurement checks really run (they PASS on genuine evidence), a report not bound to OUR
// nonce is REJECTED at the binding, a wrong pin is REJECTED at the measurement, relay misbehaviour is UNAVAILABLE, and the
// public verdict never carries the raw report, chip id or VCEK fingerprint (raw stays 0600 in evidence/private).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as P from '../attest-control.mjs';

const FX = path.join(P.REPO, 'test/fixtures');
const saved = JSON.parse(fs.readFileSync(path.join(FX, 'verifier/turin-m4a/doc.json'), 'utf8')); const m4a = saved.doc ?? saved;
const report = Buffer.from(m4a.report, 'base64'); const MEAS = report.subarray(0x90, 0xc0).toString('hex');
const CHIP = report.subarray(0x1a0, 0x1e0).toString('hex');
const { memoryCollateral } = await import(pathToFileURL(path.join(P.REPO, 'verifier/collateral.mjs')).href);
const collateral = memoryCollateral({ chains: { Turin: fs.readFileSync(path.join(FX, 'amd/Turin-cert_chain.pem'), 'utf8') },
  vceks: { Turin: fs.readFileSync(path.join(FX, 'verifier/turin-m4a/vcek-kds-amd.der')) }, crls: { Turin: fs.readFileSync(path.join(FX, 'verifier/amd/Turin-crl.der')) } });
const NOW = '2026-09-24T05:00:00Z';
const metalDoc = { format: 'sev-snp-guest-metal-v1', body: m4a.report, transportKey: m4a.transportKey, name: 'metal0' };
const relay = (answer) => async (url) => { const nonce = new URL(url).searchParams.get('nonce'); const a = answer(nonce); return { status: a.status, text: async () => JSON.stringify(a.body) }; };
const honest = relay((nonce) => ({ status: 200, body: { name: 'metal0', nonce, document: metalDoc, operatorAllowlist: { measurements: [MEAS], admittedAtAttach: MEAS } } }));

test('the verifier pins hold for the restore repo at a6b1378c', () => { P.checkPins(); });

test('genuine AMD-signed Turin evidence: chain, policy, TCB and measurement PASS, but a report not bound to OUR nonce is REJECTED', async () => {
  const { verdict, raw } = await P.probe({ expectedMeasurement: MEAS, deps: { fetchImpl: honest, collateral, now: NOW } });
  assert.equal(verdict.status, 'rejected'); assert.equal(verdict.pass, false);
  for (const k of ['report shape', 'product line', 'guest policy', 'chain', 'tcb policy', 'measurement']) assert.equal(verdict.required[k], 'PASS', k);
  assert.equal(verdict.crl, 'PASS'); assert.equal(verdict.required.binding, 'FAIL'); assert.deepEqual(verdict.failedChecks, ['binding']);
  assert.equal(verdict.product, 'Turin'); assert.equal(verdict.observedMeasurement, MEAS);
  // the public verdict never carries the raw report, the chip id or the VCEK fingerprint; the raw answer does (private)
  const pub = JSON.stringify(verdict);
  for (const secretish of [CHIP, CHIP.slice(0, 16), m4a.report.slice(0, 64)]) assert.ok(!pub.includes(secretish), 'public verdict leaks ' + secretish.slice(0, 8));
  assert.ok(!('vcekFingerprint' in verdict)); assert.match(verdict.chipIdSha256, /^[0-9a-f]{64}$/);
  assert.ok(raw.text.includes(m4a.report.slice(0, 64))); assert.equal(verdict.unavailable.length, 3);
});

test('a pin other than the observed measurement is REJECTED at the measurement (default pin = ee5df6b8)', async () => {
  const { verdict } = await P.probe({ deps: { fetchImpl: honest, collateral, now: NOW } });
  assert.equal(verdict.expectedMeasurement, P.TARGETS.new.measurement); assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.required.measurement, 'FAIL'); assert.equal(verdict.required.binding, 'UNAVAILABLE', 'a check never reached is UNAVAILABLE, not PASS');
  assert.equal(verdict.pass, false); assert.equal(verdict.measurementMatches, false);
});

test('relay misbehaviour is UNAVAILABLE and never a pass: another nonce, an HTTP error, a non-metal document, a network failure', async () => {
  const cases = [relay(() => ({ status: 200, body: { name: 'metal0', nonce: '00'.repeat(32), document: metalDoc } })),
                 relay(() => ({ status: 504, body: { error: 'timeout' } })),
                 relay((nonce) => ({ status: 200, body: { name: 'metal0', nonce, document: { ...metalDoc, format: 'sev-snp-guest-domain-v1' } } })),
                 async () => { throw new Error('ECONNREFUSED'); }];
  for (const fetchImpl of cases) {
    const { verdict } = await P.probe({ deps: { fetchImpl, collateral, now: NOW } });
    assert.equal(verdict.status, 'unavailable'); assert.equal(verdict.pass, false);
    assert.ok(Object.values(verdict.required).every((x) => x === 'UNAVAILABLE'));
  }
});

test('persist: the raw answer is 0600 in a 0700 private dir, nothing is overwritten, the public file has no raw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-'));
  const { verdict, raw } = await P.probe({ expectedMeasurement: MEAS, deps: { fetchImpl: honest, collateral, now: NOW } });
  const f = P.persist(verdict, raw, dir);
  assert.equal(fs.statSync(f.rawFile).mode & 0o777, 0o600); assert.equal(fs.statSync(path.join(dir, 'private')).mode & 0o777, 0o700);
  assert.ok(!fs.readFileSync(f.pub, 'utf8').includes(m4a.report.slice(0, 64)));
  assert.throws(() => P.persist(verdict, raw, dir), /EEXIST/);
  const crypto = await import('node:crypto');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f.rawFile)).digest('hex'), verdict.rawSha256);
});

test('checkImage ties each pin to the reviewed image files and refuses another file', () => {
  const t = { ...P.TARGETS.new, image: path.resolve(P.REPO, '../stage/dist-leasegas-a6b1378cd') };
  const orig = P.TARGETS.new; P.TARGETS.new = t;
  try {
    P.checkImage('new');
    P.TARGETS.new = { ...t, files: { ...t.files, 'manifest.json': '0'.repeat(64) } }; assert.throws(() => P.checkImage('new'), /not the reviewed file/);
    P.TARGETS.new = { ...t, measurement: '1'.repeat(96) }; assert.throws(() => P.checkImage('new'), /does not name the pin/);
  } finally { P.TARGETS.new = orig; }
});
