// Evaluators for recorded hardware, search, chain and limitation observations. Log lines use the exact formats of the
// guest front (isolation/m2/front/custody.go 290, main.go 681) and the custodian (custodian.mjs release log).
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "../driver/assert.mjs";

const C1 = "0x" + "c1".repeat(32), OTHER = "0x" + "77".repeat(32);
const MEAS = "9709716c9b63e1d2a048347478fbd6a94d42babd222e7bc8e18422e5b9075c840844e5213feaaf5fb3a3949dd30ad230";
const front = (rev, id = C1) => `2026-10-23T21:00:00Z DOM custody: deployment 0x${id.slice(2, 10)}... secrets revision ${rev} from a v2 threshold of 1 over 1 custodian machines, 2 name(s)`;
const ok = (id = C1, meas = MEAS, synth = false) => `[custodian-v2 f0f8078459c0] release ${id} to https://api.enclave.host/t/metal0: OK (indices 1, measurement ${meas.slice(0, 16)}...${synth ? ", SYNTHETIC roots" : ""})`;
const no = (code, msg, id = C1) => `[custodian-v2 f0f8078459c0] release ${id} to https://api.enclave.host/t/metal0: REFUSED ${code}: ${msg}`;
const ERR = "DOM ERROR front: provision: custody: 1 of 1 machines: released nothing: 403 evidence_refused";
const lines = (f, c) => A.filterLines({ frontLog: f.join("\n"), custodianLog: c.join("\n"), id: C1 });

test("filterLines keeps only this deployment's custodian lines and the front custody lines", () => {
  const l = lines([front(1), front(1, OTHER), "unrelated"], [ok(), ok(OTHER), no("paused", "x", OTHER)]);
  assert.equal(l.front.length, 1); assert.equal(l.custodian.length, 1);
});

test("release: passes only with the front revision line, a real-roots OK of the pinned image, no refusal, app answering", () => {
  const good = { lines: lines([front(2)], [ok()]), appAnswered: true };
  assert.equal(A.evalRelease({ id: C1, obs: good, expect: { secretRev: 2 }, imageMeasurement: MEAS }).outcome, "pass");
  const fails = [
    [{ lines: lines([front(1)], [ok()]), appAnswered: true }, /revision 2/],
    [{ lines: lines([front(2)], [ok(C1, MEAS, true)]), appAnswered: true }, /SYNTHETIC/],
    [{ lines: lines([front(2)], [ok(C1, "ab".repeat(48))]), appAnswered: true }, /pinned recipient image/],
    [{ lines: lines([front(2)], []), appAnswered: true }, /no custodian/],
    [{ lines: lines([front(2)], [ok(), no("paused", "x")]), appAnswered: true }, /refusals/],
    [{ lines: lines([front(2), ERR], [ok()]), appAnswered: true }, /front custody error/],
    [{ lines: lines([front(2)], [ok()]), appAnswered: false }, /did not answer/],
  ];
  for (const [obs, re] of fails) {
    const r = A.evalRelease({ id: C1, obs, expect: { secretRev: 2 }, imageMeasurement: MEAS });
    assert.equal(r.outcome, "fail"); assert.match(r.reasons.join("; "), re);
  }
});

test("refusal: the expected code, no OK, a front custody error, and the app NOT started", () => {
  const exp = { codes: ["evidence_refused"], message: "measurement" };
  const good = { lines: lines([ERR], [no("evidence_refused", "the measurement is not admitted")]), appAnswered: false };
  assert.equal(A.evalRefusal({ id: C1, obs: good, expect: exp }).outcome, "pass");
  for (const [obs, re] of [
    [{ lines: lines([ERR], [no("evidence_refused", "VCEK chain")]), appAnswered: false }, /mentioning 'measurement'/],
    [{ lines: lines([ERR], [no("runtime_not_admitted", "x")]), appAnswered: false }, /no custodian refusal/],
    [{ lines: lines([ERR], [no("evidence_refused", "the measurement is not admitted"), ok()]), appAnswered: false }, /GRANTED/],
    [{ lines: lines([], [no("evidence_refused", "the measurement is not admitted")]), appAnswered: false }, /no front custody error/],
    [{ lines: lines([ERR], [no("evidence_refused", "the measurement is not admitted")]), appAnswered: true }, /app answered/],
  ]) { const r = A.evalRefusal({ id: C1, obs, expect: exp }); assert.equal(r.outcome, "fail"); assert.match(r.reasons.join("; "), re); }
  // the stopped-custodian case is judged by the front's quorum line
  const q = { lines: A.filterLines({ frontLog: "DOM ERROR front: custody: insufficient custodian quorum: the 0 of 1 machines that issued a challenge hold 0 share indices (need 1)", custodianLog: no("paused", "x"), id: C1 }), appAnswered: false };
  assert.equal(A.evalRefusal({ id: C1, obs: q, expect: { codes: ["paused"] } }).outcome, "pass");
});

test("marker search: zero hits AND a working control at every location; missing counts fail", () => {
  const base = { sets: ["c1-rev1"], locations: ["relay-journal", "custodian-state"], control: { "relay-journal": 3, "custodian-state": 1 } };
  assert.equal(A.evalMarkerSearch({ ...base, counts: { "c1-rev1@relay-journal": 0, "c1-rev1@custodian-state": 0 } }).outcome, "pass");
  assert.equal(A.evalMarkerSearch({ ...base, counts: { "c1-rev1@relay-journal": 1, "c1-rev1@custodian-state": 0 } }).outcome, "fail");
  assert.equal(A.evalMarkerSearch({ ...base, counts: { "c1-rev1@relay-journal": 0 } }).outcome, "fail");
  assert.equal(A.evalMarkerSearch({ ...base, control: { "relay-journal": 0, "custodian-state": 1 }, counts: { "c1-rev1@relay-journal": 0, "c1-rev1@custodian-state": 0 } }).outcome, "fail");
});

test("rollback: an older valid sealed blob is EXPECTED-FAIL; an old-secret refusal is labelled chain-revision only", () => {
  const r = A.evalRollback({ obs: { olderBlobOpened: true, sameIdentity: true, oldSecretRevisionRefused: true } });
  assert.equal(r.outcome, "expected-fail");
  assert.match(r.evidence.label, /CHAIN revision check only; NOT sealed-state anti-replay/);
  assert.match(r.evidence.limitation, /no monotonic anchor/);
  assert.notEqual(A.evalRollback({ obs: { olderBlobOpened: true } }).outcome, "pass");
  assert.equal(A.evalRollback({ obs: { custodianRefusedOldState: true } }).outcome, "fail"); // never a pass, even if claimed
});

test("policy check, inventory and the protected-policy comparison", () => {
  const facts = { block: "1", owner: "0x29479bf04ed889d46a7afb7f292b9bb26e12647c", policyRev: "1", secretRev: "1",
    committeeId: "0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3", bundleKeccak: "0xaa", rulesKeccak: "0xbb", relayCustody: true };
  const prepared = { summary: { bundleKeccak: "0xaa", rulesKeccak: "0xbb" } };
  const expect = { policyRev: "1", secretRev: "1", custodyFlag: true };
  assert.equal(A.evalPolicyCheck({ facts, expect, ownerAddress: facts.owner, prepared }).outcome, "pass");
  assert.equal(A.evalPolicyCheck({ facts: { ...facts, bundleKeccak: "0xcc" }, expect, ownerAddress: facts.owner, prepared }).outcome, "fail");
  assert.equal(A.evalPolicyCheck({ facts: { ...facts, relayCustody: false }, expect, ownerAddress: facts.owner, prepared }).outcome, "fail");
  const pins = { vaultCodeHash: "0x4b", custodian: { measurementSha256: "0x25" } };
  const inv = { vaultCodeHash: "0x4b", committee: { epoch: 1, t: 1, W: 1, machines: [{ endpoint: "https://api.enclave.host/t/custody-metal0", measurement: "0x25" }] },
    protected: { id: "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e", bundleKeccak: "0x" + "e4".repeat(32) }, ownerBalanceWei: "61654449641751", ownerNonce: 10 };
  const budget = { largestStepWei: "24000000000000", worstCaseWei: "122000000000000" };
  let o = A.evalInventory({ facts: inv, pins, budget });
  assert.ok(Object.values(o).every((x) => x.ok));
  o = A.evalInventory({ facts: { ...inv, committee: { ...inv.committee, t: 2 } }, pins, budget });
  assert.equal(o["read.committee"].ok, false);
  o = A.evalInventory({ facts: { ...inv, ownerBalanceWei: "1" }, pins, budget });
  assert.equal(o["read.owner"].ok, false);
  assert.equal(A.evalProtectedUnchanged({ before: { policyRev: "2", secretRev: "2" }, after: { policyRev: "2", secretRev: "2" } }).outcome, "pass");
  assert.equal(A.evalProtectedUnchanged({ before: { policyRev: "2" }, after: { policyRev: "3" } }).outcome, "fail");
  assert.equal(A.evalCustodianInfo({ info: { encKey: "0xAB", vault: "0xe48699b8401564aace7a814ae4569b67a3f7eef5" }, committee: { machines: [{ encKey: "0xab" }] } })["custodian.info"].ok, true);
  assert.equal(A.evalCustodianInfo({ info: { encKey: "0xAC", vault: "0xe48699b8401564aace7a814ae4569b67a3f7eef5" }, committee: { machines: [{ encKey: "0xab" }] } })["custodian.info"].ok, false);
});
