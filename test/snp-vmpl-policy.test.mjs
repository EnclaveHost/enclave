// Which privilege level a report came from is a POLICY, pinned by the caller, not a field to record and
// move past.
//
// A SEV-SNP report carries the VMPL that asked for it (Linux writes it through configfs-tsm `privlevel`,
// documented up to TSM_PRIVLEVEL_MAX = 3, with `privlevel_floor` = the guest's own level). The launch
// measurement is the SAME at every level, because it covers the CVM's initial memory as a whole. So in a
// guest with a monitor at VMPL0 and app domains beneath it (isolation/DESIGN.md section 12), the VMPL
// field is the only thing that tells a verifier whether the monitor or a lower-privilege domain produced
// the evidence — and the two are not interchangeable, because whatever runs above a domain is in that
// domain's TCB.
//
// verifyQuote defaults to VMPL0, which is what every enclave the platform runs today reports. Accepting a
// lower level requires saying which one.
//
//   run: node --test test/snp-vmpl-policy.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { verifyQuote } from "../relay/snp-verify.mjs";

const MEAS = "33".repeat(48), SPKI = randomBytes(91), NONCE = randomBytes(32);

function report({ vmpl = 0 } = {}) {
  const r = Buffer.alloc(0x4a0);
  r.writeUInt32LE(5, 0x00);
  r.writeBigUInt64LE(0x30000n, 0x08);
  r.writeUInt32LE(vmpl, 0x30);
  createHash("sha256").update(Buffer.concat([SPKI, NONCE])).digest().copy(r, 0x50);
  Buffer.from(MEAS, "hex").copy(r, 0x90);
  r[0x188] = 0x1a; r[0x189] = 0x02;                       // Turin, so the product line is nameable
  Buffer.from("0103020500000075", "hex").copy(r, 0x180);
  return r;
}
// no VCEK is needed to exercise the VMPL gate: it is checked before the chain
const verify = (r, extra = {}) => verifyQuote(r, {
  challenge: NONCE, transportKeySpki: SPKI, allowedMeasurements: [MEAS], requireVcek: false, kds: false, ...extra });

test("the default is VMPL0, and a lower plane's report is refused unless the caller asked for it", async () => {
  const zero = await verify(report());
  assert.equal(zero.ok, true);
  assert.equal(zero.vmpl, 0);
  assert.ok(zero.reasons.some((s) => /VMPL0 \(full privilege/.test(s)), zero.reasons.join("; "));

  for (const vmpl of [1, 2, 3]) {
    const res = await verify(report({ vmpl }));
    assert.equal(res.ok, false, `VMPL${vmpl} must not pass the default policy`);
    assert.equal(res.reasons.at(-1), `VMPL ${vmpl} != expected 0`);
  }
});

test("a caller that expects a given plane gets that plane and nothing else", async () => {
  for (const want of [1, 2, 3]) {
    const match = await verify(report({ vmpl: want }), { expectedVmpl: want });
    assert.equal(match.ok, true, `VMPL${want} expected and reported must pass`);
    assert.equal(match.vmpl, want);
    // the reason says what was accepted AND what that costs in TCB terms
    assert.ok(match.reasons.some((s) => new RegExp(`from VMPL${want}, as the caller expected`).test(s)
      && /more privileged and in its TCB/.test(s)), match.reasons.join("; "));

    // the same expectation refuses every other level, VMPL0 included: a monitor's report must not
    // satisfy a check meant for a domain, nor the reverse
    for (const got of [0, 1, 2, 3].filter((v) => v !== want)) {
      const res = await verify(report({ vmpl: got }), { expectedVmpl: want });
      assert.equal(res.ok, false, `expected VMPL${want}, report VMPL${got} must fail`);
      assert.equal(res.reasons.at(-1), `VMPL ${got} != expected ${want}`);
    }
  }
});

test("an unusable expectation is refused rather than rounded into one that passes", async () => {
  for (const bad of [4, -1, 1.5, "2", null, {}, NaN]) {
    const res = await verify(report({ vmpl: 2 }), { expectedVmpl: bad });
    assert.equal(res.ok, false, `expectedVmpl ${JSON.stringify(bad)} must be refused`);
    assert.match(res.reasons.at(-1), /^expectedVmpl must be an integer 0-3/);
  }
  // ...and it is checked before anything expensive: no VCEK, no KDS, no measurement lookup was needed
  const res = await verify(report(), { expectedVmpl: 9, allowedMeasurements: [] });
  assert.match(res.reasons.at(-1), /^expectedVmpl must be an integer 0-3/);
  assert.equal(res.reasons.length, 1);

  // an OMITTED expectation is the strict default, never a lenient one: undefined means VMPL0
  const omitted = await verify(report({ vmpl: 2 }), { expectedVmpl: undefined });
  assert.equal(omitted.ok, false);
  assert.equal(omitted.reasons.at(-1), "VMPL 2 != expected 0");
  assert.equal((await verify(report(), { expectedVmpl: undefined })).ok, true);
});

test("the VMPL gate is not a substitute for the rest of the checks", async () => {
  // a domain-level report still has to bind the key and the challenge, and match the allowlist
  const r = report({ vmpl: 2 });
  const other = await verifyQuote(r, { challenge: randomBytes(32), transportKeySpki: SPKI,
    allowedMeasurements: [MEAS], requireVcek: false, kds: false, expectedVmpl: 2 });
  assert.equal(other.ok, false);
  assert.match(other.reasons.at(-1), /report_data does not bind/);
  const offList = await verify(r, { expectedVmpl: 2, allowedMeasurements: ["44".repeat(48)] });
  assert.equal(offList.ok, false);
  assert.match(offList.reasons.at(-1), /not on the Metal release allowlist/);
});
