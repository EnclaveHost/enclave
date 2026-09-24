// The VMPL0-refusal property, on the VERIFIER side.
//
// The gap this closes: a signed report naming VMPL2 does not show confinement. A guest at VMPL0 holds
// every VMPCK and can request a report naming a lower privilege level, so "the report says VMPL2" is
// equally consistent with being confined beneath a VMPL0 monitor and with being VMPL0 and saying
// otherwise. The distinguishing fact is being REFUSED a report at level 0. These cases pin that a
// verifier demanding VMPL>0 rejects every tuple that fails to record that refusal.
import { test } from 'node:test';
import assert from 'node:assert';
import { checkBoundary } from '../isolation/m2/judge.mjs';

const ok2 = 'tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused';

test('the only tuple accepted at VMPL2 is a coherent one recording the refusal', () => {
  const r = checkBoundary(ok2, 2, 2);
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.match(r.reasons.join(' '), /refused level-0 probe/);
  // and it must say out loud what that refusal is NOT. Corrected 2026-09-23: this used to assert the
  // reasons called the refusal the unfakeable part, which is measured false (see the test below).
  assert.match(r.reasons.join(' '), /does NOT show this guest lacks VMPCK0/);
  assert.match(r.reasons.join(' '), /MEASUREMENT/);
});

test('the refusal is NOT evidence of confinement, and the reasons must say so (measured 2026-09-23)', () => {
  // A plain SNP guest with no SVSM above it - therefore AT VMPL0 - produces this tuple byte for byte, by
  // loading sev-guest with vmpck_id=2: tsm-report refuses a privlevel below its floor in its own check, and
  // the floor is that module parameter, so no VMPCK is consulted. Measured twice on one image:
  //   vmpck_id=0 -> floor 0, signed report vmpl=0, level 0 GRANTED   (the control: it is unconfined)
  //   vmpck_id=2 -> floor 2, level 0 REFUSED with EINVAL             (the tuple below)
  // So no verifier can tell the two apart from the tuple, and this one does not pretend to: it accepts a
  // COHERENT tuple and states that confinement rests on the pinned measurement instead.
  const forged = 'tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused';
  assert.equal(forged, ok2, 'the forged tuple is byte-identical to the honest one');
  const r = checkBoundary(forged, 2, 2);
  assert.equal(r.ok, true, 'it is accepted, because it is coherent');
  const why = r.reasons.join(' ');
  assert.match(why, /vmpck_id/, 'the reasons must name the mechanism that forges it');
  assert.doesNotMatch(why, /cannot be faked/, 'nothing here may claim the refusal is unfakeable');
  assert.doesNotMatch(why, /which is what distinguishes being confined/, 'nor that it distinguishes confinement');
});

test('a missing self-test is a REJECT once confinement is demanded', () => {
  for (const absent of [undefined, null, '']) {
    assert.equal(checkBoundary(absent, 2, 2).ok, false, `${JSON.stringify(absent)} was accepted`);
  }
  // but absence is fine at VMPL0, where no confinement is claimed: M2 documents carry no tuple
  assert.equal(checkBoundary(undefined, 0, 0).ok, true);
});

test('GRANTED is rejected at every level, however good the rest reads', () => {
  for (const [b, want, rv] of [
    ['tier=t1 vmpl=2 vmpl_floor=2 vmpl0=GRANTED', 2, 2],
    ['tier=t1 vmpl=0 vmpl_floor=0 vmpl0=GRANTED', 0, 0],
    ['tier=t1 vmpl=3 vmpl_floor=3 vmpl0=GRANTED', 3, 3],
  ]) {
    const r = checkBoundary(b, want, rv);
    assert.equal(r.ok, false, `${b} was accepted`);
    assert.match(r.reasons.join(' '), /obtained a report at VMPL0/);
  }
});

test('a probe that never ran is not a pass', () => {
  assert.equal(checkBoundary('tier=t1 vmpl=2 vmpl_floor=2 vmpl0=n/a', 2, 2).ok, false);
});

test('the downward-claim forgery is rejected: floor 0 while naming a lower level', () => {
  assert.equal(checkBoundary('tier=t1 vmpl=2 vmpl_floor=0 vmpl0=refused', 2, 2).ok, false);
  assert.equal(checkBoundary('tier=t1 vmpl=2 vmpl_floor=0 vmpl0=n/a', 2, 2).ok, false);
});

test('a relayed claim that disagrees with the SIGNED report is rejected', () => {
  // the signed field says 0, the relayed tuple claims 2
  const r = checkBoundary(ok2, 2, 0);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /SIGNED report says VMPL0/);
});

test('a tuple for the wrong level is rejected', () => {
  assert.equal(checkBoundary('tier=t1 vmpl=1 vmpl_floor=1 vmpl0=refused', 2, 1).ok, false);
  assert.equal(checkBoundary('tier=t1 vmpl=3 vmpl_floor=2 vmpl0=refused', 2, 3).ok, false);
});

test('a T0 tuple cannot satisfy a demand for confinement', () => {
  assert.equal(checkBoundary('tier=t0 vmpl=n/a vmpl_floor=n/a vmpl0=n/a', 2, 2).ok, false);
});

test('malformed, duplicated and oversized tuples are rejected', () => {
  for (const b of [
    'garbage',
    'tier=t1 vmpl=2 vmpl_floor=2',                                  // vmpl0 missing
    'tier=t1 vmpl=2 vmpl0=refused',                                 // vmpl_floor missing
    'vmpl=2 vmpl_floor=2 vmpl0=refused',                            // tier missing
    'tier=t1 vmpl=2 vmpl=0 vmpl_floor=2 vmpl0=refused',             // duplicate key
    'tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused vmpl0=GRANTED',      // duplicate, second one fatal
    'tier=t1 vmpl=2 vmpl_floor=2 vmpl0=Refused',                    // near-miss spelling
    'tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused ' + 'x'.repeat(300), // oversized
  ]) {
    assert.equal(checkBoundary(b, 2, 2).ok, false, `${JSON.stringify(b)} was accepted`);
  }
});

test('VMPL0 documents that contradict themselves are still rejected', () => {
  // expecting 0 but the self-test says it is somewhere else
  assert.equal(checkBoundary('tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused', 0, 2).ok, false);
});

// --- the same property through judge(), which is what a client actually calls -----------------------
//
// checkBoundary being correct is not enough: it has to be REACHED. It was first placed after the
// `unauthenticated` return, so the lab-unsigned diagnostic never reached it and accepted every bad tuple.
// That was found by replaying a real report from hardware, so it gets pinned here.
import { createHash, randomBytes } from 'node:crypto';
import { judge } from '../isolation/m2/judge.mjs';

const MEAS = '44'.repeat(48), SPKI = randomBytes(91), NONCE = randomBytes(32);
const APP = 'ab'.repeat(32);

function docAt(vmpl, boundary) {
  const r = Buffer.alloc(0x4a0);
  r.writeUInt32LE(5, 0x00);
  r.writeBigUInt64LE(0x30000n, 0x08);
  r.writeUInt32LE(vmpl, 0x30);
  createHash('sha256').update(Buffer.concat([SPKI, NONCE])).digest().copy(r, 0x50);
  Buffer.from(APP, 'hex').copy(r, 0x70);           // report_data[32:64] names the app
  Buffer.from(MEAS, 'hex').copy(r, 0x90);
  r[0x188] = 0x1a; r[0x189] = 0x02;
  Buffer.from('0103020500000075', 'hex').copy(r, 0x180);
  const d = { tier: 'T1', format: 'sev-snp-guest-domain-v1', report: r.toString('base64') };
  if (boundary !== undefined) d.boundary = boundary;
  return d;
}
const ask = (doc, expectedVmpl, mode = 'lab-unsigned') =>
  judge(doc, SPKI, NONCE, { measurement: MEAS, appSha: APP, mode, kds: false, expectedVmpl });

test('an incoherent tuple is a REJECT in the permissive lab-unsigned mode, not merely unauthenticated', async () => {
  // this is the ordering bug: lab-unsigned used to return before the boundary was ever judged
  const granted = await ask(docAt(0, 'tier=t1 vmpl=0 vmpl_floor=0 vmpl0=GRANTED'), 0);
  assert.equal(granted.verdict, 'reject', granted.reasons.join('; '));
  assert.equal(granted.gateOpen, false);
  // and a good one still gets the mode's normal verdict
  const good = await ask(docAt(0, 'tier=t1 vmpl=0 vmpl_floor=0 vmpl0=n/a'), 0);
  assert.equal(good.verdict, 'unauthenticated');
});

test('at VMPL2 a signed report is NOT enough: without the refusal the gate stays closed', async () => {
  // the M3b shape, simulated: the signed level is exactly what was demanded, and that is still not proof
  const noTuple = await ask(docAt(2, undefined), 2);
  assert.equal(noTuple.verdict, 'reject', noTuple.reasons.join('; '));
  assert.equal(noTuple.gateOpen, false);
  assert.match(noTuple.reasons.join(' '), /consistent with a VMPL0 guest claiming a lower level/);

  const granted = await ask(docAt(2, 'tier=t1 vmpl=2 vmpl_floor=2 vmpl0=GRANTED'), 2);
  assert.equal(granted.verdict, 'reject');

  const neverRan = await ask(docAt(2, 'tier=t1 vmpl=2 vmpl_floor=2 vmpl0=n/a'), 2);
  assert.equal(neverRan.verdict, 'reject');

  // only a coherent tuple gets past the boundary gate - and the verdict says what that is and is not worth
  const ok = await ask(docAt(2, 'tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused'), 2);
  assert.equal(ok.verdict, 'unauthenticated', ok.reasons.join('; '));  // unauthenticated only for want of a VCEK
  assert.match(ok.reasons.join(' '), /refused level-0 probe/);
  assert.match(ok.reasons.join(' '), /does NOT show this guest lacks VMPCK0/);
});

test('a tuple that disagrees with the signed level is rejected', async () => {
  // signed report says VMPL2, the relayed tuple claims VMPL3 - and VMPL2 was demanded
  const j = await ask(docAt(2, 'tier=t1 vmpl=3 vmpl_floor=3 vmpl0=refused'), 2);
  assert.equal(j.verdict, 'reject', j.reasons.join('; '));
});

test('the boundary verdict is also enforced in trusted mode', async () => {
  const j = await judge(docAt(2, 'tier=t1 vmpl=2 vmpl_floor=2 vmpl0=GRANTED'), SPKI, NONCE,
    { measurement: MEAS, appSha: APP, mode: 'trusted', kds: false, expectedVmpl: 2 });
  assert.equal(j.verdict, 'reject');
  assert.equal(j.gateOpen, false);
});
