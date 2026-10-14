// The SVSM-computed ABI/2 binding, judged from the report the hardware actually signed.
//
// M4b step 1 moved the binding into the measured SVSM: it records a plane's transport-key SPKI once at plane
// start and computes report_data[0:32] = Bind2(SPKI, nonce, RuntimeID) itself, with the RuntimeID compiled into
// its measured image. These cases run against the COMMITTED evidence from that hardware run
// (isolation/m4/evidence/admit-good-2026-09-23.txt), so they check the bytes a real PSP signed rather than a
// construction of this test's own.
//
// Two of them are the negatives an independent review asked for and I owed: a report presented under ANOTHER
// key must fail the binding, and so must one presented under another nonce. Both matter because the verifier
// recomputes the binding from the key its OWN handshake saw and the nonce IT chose - if either could differ
// from what the SVSM bound, a report could be replayed onto a different connection.
//
//   run: node --test test/isolation-svsm-binding.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { bind2 } from '../isolation/contract/runtime.mjs';

const EV = new URL('../isolation/m4/evidence/admit-good-2026-09-23.txt', import.meta.url);
const lines = fs.readFileSync(EV, 'latin1').split('\n');
const field = (k) => {
  const l = lines.find((x) => x.startsWith(`ADMIT ${k}=`));
  return l ? l.slice(`ADMIT ${k}=`.length).trim() : null;
};

// the run's inputs, as the evidence records them
const spki = Buffer.from(field('key_registered'), 'hex');
const nonce = Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90'.repeat(2), 'hex');   // admitinit's nonce
const runtimeId = Buffer.from('ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8', 'hex');
const raw = Buffer.from(field('report_hex'), 'hex');
const report = raw.subarray(32, 32 + raw.readUInt32LE(4));   // past the SVSM's response header
const reportBinding = report.subarray(0x50, 0x70);
const reportApp = report.subarray(0x70, 0x90);

test('the evidence carries a real report with the shape the SVSM produces', () => {
  assert.equal(raw.readUInt32LE(0), 0, 'the SVSM response status must be success');
  assert.equal(report.length, 1184, 'an SNP report is 1184 bytes');
  assert.equal(report.readUInt32LE(0x30), 2, 'the report must name the plane, not VMPL0');
  assert.equal(spki.length, 91, 'a P-256 SubjectPublicKeyInfo is 91 bytes (contract RUNTIME.md requirement 6)');
});

test('report_data[0:32] is the contract Bind2 over the key the plane REGISTERED', () => {
  // the positive: the SVSM's own computation, recomputed here by the contract's implementation
  assert.deepEqual(reportBinding, bind2(spki, nonce, runtimeId),
    'the binding must be Bind2(registered SPKI, nonce, RuntimeID)');
  assert.equal(reportApp.toString('hex'), 'ce52712f14ed972c66a97c8ca046d69f0c4133d9b7a7fdb27d4ea307dd310b91',
    'and [32:64] must be the AppID from the measured table');
});

test('the same report under ANOTHER transport key fails the binding', () => {
  // A verifier recomputes from the key ITS handshake saw. If this passed, a report could be lifted onto a
  // different connection - which is the whole reason the key is bound at all.
  for (const other of [randomBytes(91), Buffer.alloc(91), (() => { const b = Buffer.from(spki); b[90] ^= 1; return b; })()]) {
    assert.notDeepEqual(reportBinding, bind2(other, nonce, runtimeId),
      'a different SPKI must not reproduce the binding');
  }
  // including one that differs in a single bit of the last byte, so this is not passing on length alone
  const oneBit = Buffer.from(spki); oneBit[0] ^= 0x01;
  assert.notDeepEqual(reportBinding, bind2(oneBit, nonce, runtimeId));
});

test('the same report under ANOTHER nonce fails the binding', () => {
  for (const other of [randomBytes(32), Buffer.alloc(32), (() => { const b = Buffer.from(nonce); b[31] ^= 1; return b; })()]) {
    assert.notDeepEqual(reportBinding, bind2(spki, other, runtimeId),
      'a different nonce must not reproduce the binding: that is the freshness half');
  }
});

test('the same report under ANOTHER RuntimeID fails the binding', () => {
  // the label is compiled into the measured image, so a document claiming a different runtime cannot verify
  const other = Buffer.from(runtimeId); other[0] ^= 0xff;
  assert.notDeepEqual(reportBinding, bind2(spki, nonce, other));
});

test('a verifier that recomputes from all three inputs accepts exactly one combination', () => {
  // the point of the mechanism, stated as a test: the binding pins key AND nonce AND runtime together, so no
  // two of them can be swapped for another pair that still verifies
  const ok = bind2(spki, nonce, runtimeId);
  const wrongKey = bind2(randomBytes(91), nonce, runtimeId);
  const wrongNonce = bind2(spki, randomBytes(32), runtimeId);
  const wrongRuntime = bind2(spki, nonce, randomBytes(32));
  const all = [ok, wrongKey, wrongNonce, wrongRuntime].map((b) => b.toString('hex'));
  assert.equal(new Set(all).size, 4, 'each input must change the binding independently');
  assert.equal(all[0], reportBinding.toString('hex'), 'and only the true combination matches the report');
});
