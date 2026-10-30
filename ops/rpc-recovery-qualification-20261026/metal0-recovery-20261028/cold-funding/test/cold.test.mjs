// The COLD profile (verified cold shutdown): exactly the two protected deployments, expired >= 360 s, original owner/runner,
// root's quiesce.cold facts; plans and approvals bound to ONE profile. Pure: synthetic facts, no chain, no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRODUCTION, COLD, buildPlan, createPreparer, designatorOf, coldProfileSha256, sha256, Refusal } from "../lib/maintenance.mjs";
import { PROTECTED_IDS } from "../lib/protected-inventory.mjs";
import { checkExecutablePlan, checkApproval, createSender, APPROVAL_KIND, COLD_APPROVAL_KIND } from "../lib/sender.mjs";

const P = PRODUCTION, TS = 1_792_800_000, EXPIRED = TS - 46_080;   // 12.8 h expired
const [ID1, ID2] = PROTECTED_IDS, FOREIGN = "0x" + "ee".repeat(32);
const lease = (patch = {}) => ({ active: true, runnerOperator: P.operator, leaseUntil: EXPIRED, rate: "0", owner: COLD.owner, runner: COLD.runner, ...patch });
const facts = (patch = {}, leases = { [ID1]: lease(), [ID2]: lease() }) => ({ block: "53005000", blockHash: "0x" + "ab".repeat(32), blockTimestamp: TS, rpcs: ["a", "b"],
  operatorCode: designatorOf(P.executor), sponsorCode: "0x", executorCodeHash: P.executorCodeHash, reserveCodeHash: P.reserveCodeHash,
  reserveExecutor: P.executor, reserveDelegationCodeHash: P.delegationCodeHash, ledgerCodeHash: P.ledgerCodeHash, leases, leaseSec: "1800",
  operatorNonce: { atBlock: 23760, latest: 23760, pending: 23760 }, sponsorNonce: { atBlock: 41, latest: 41, pending: 41 },
  operatorBalance: "145368427115", sponsorBalance: "7000000000000", storage: {}, executorViews: {}, plainTransferReverts: true,
  codelessTransferSimulation: "n/a", baseFeePerGas: 5_000_000n, maxPriorityFeePerGas: 1_000_000n, ...patch });
const cold = (patch = {}) => ({ profile: COLD.marker, preservationReceiptSha256: "0x" + "5e".repeat(32), stoppedAtSec: TS - 3000, noGuestUnits: true, noGuestRecords: true, ...patch });
const quiesce = (patch = {}) => ({ providedBy: "root", providedAt: TS - 60, signersStopped: ["metal0 control", "lease keeper"], lastSponsoredLeaseDeadline: TS - 900,
  leases: [{ id: ID1, expiry: EXPIRED }, { id: ID2, expiry: EXPIRED }], cold: cold(), ...patch });
const oracle = () => ({ isIsthmus: async () => true, l1UpperBound: async () => 50_000_000_000n, operatorFee: async () => 0n });
const build = (args = {}) => buildPlan({ cfg: P, facts: facts(), quiesce: quiesce(), oracle: oracle(), profile: "cold", ...args });
const refuses = (code, args) => assert.rejects(build(args), (e) => (e instanceof Refusal && e.code === code) || assert.fail(`${code}: ${e.code} ${e.message}`));

test("cold: the exact expired, owned, C9-held pair with root's cold facts yields an executable cold plan (V, cap, nonces unchanged)", async () => {
  const { plan, text } = await build();
  assert.equal(plan.kind, "enclave-operator-7702-maintenance/executable-cold");
  assert.deepEqual(plan.profile, { mode: "cold", marker: COLD.marker, sha256: coldProfileSha256() });
  assert.equal(plan.quiesce.mode, "cold"); assert.deepEqual(plan.quiesce.leases.map((l) => [l.id, l.expiredSec]), [[ID1, 46_080], [ID2, 46_080]]);
  assert.equal(plan.pins.valueWei, "5000000000000"); assert.equal(plan.pins.feeCapWei, "2000000000000");
  assert.deepEqual(plan.authorizationsToSign.map((a) => [a.tuple.address, a.tuple.nonce]), [["0x0000000000000000000000000000000000000000", 23760], [P.executor, 23761]]);
  assert.doesNotThrow(() => checkExecutablePlan(P, JSON.parse(text), "cold"));
  // the stop boundary: exactly 360 s at the agreed block passes, 359 s refuses
  await assert.doesNotReject(build({ quiesce: quiesce({ cold: cold({ stoppedAtSec: TS - 360 }) }) }));
  await assert.doesNotReject(build({ facts: facts({}, { [ID1]: lease({ leaseUntil: TS - 360 }), [ID2]: lease() }), quiesce: quiesce({ leases: [{ id: ID1, expiry: TS - 360 }, { id: ID2, expiry: EXPIRED }] }) }));
});

test("cold inventory: missing, partial, duplicate or extra deployments refuse", async () => {
  await refuses("cold_inventory", { quiesce: quiesce({ leases: [] }) });
  await refuses("cold_inventory", { quiesce: quiesce({ leases: [{ id: ID1, expiry: EXPIRED }] }) });
  await refuses("cold_inventory", { quiesce: quiesce({ leases: [{ id: ID1, expiry: EXPIRED }, { id: ID1, expiry: EXPIRED }] }) });
  await refuses("cold_inventory", { quiesce: quiesce({ leases: [{ id: ID1, expiry: EXPIRED }, { id: FOREIGN, expiry: EXPIRED }] }) });
  await refuses("cold_inventory", { quiesce: quiesce({ leases: [{ id: ID1, expiry: EXPIRED }, { id: ID2, expiry: EXPIRED }, { id: FOREIGN, expiry: EXPIRED }] }) });
  await refuses("cold_inventory", { quiesce: quiesce({ leases: undefined }) });
});

test("cold leases: a live or recently expired lease, inactive, foreign holder/owner/runner, stale expiry all refuse", async () => {
  const one = (l, expiry = l.leaseUntil ?? EXPIRED) => ({ facts: facts({}, { [ID1]: lease(l), [ID2]: lease() }), quiesce: quiesce({ leases: [{ id: ID1, expiry }, { id: ID2, expiry: EXPIRED }] }) });
  await refuses("lease_active", one({ leaseUntil: TS + 1500 }));
  await refuses("lease_active", one({ leaseUntil: TS - 359 }));
  await refuses("lease_holder", one({ active: false }));
  await refuses("lease_holder", one({ runnerOperator: "0x" + "11".repeat(20) }));
  await refuses("lease_owner", one({ owner: "0x" + "22".repeat(20) }));
  await refuses("lease_owner", one({ owner: undefined }));
  await refuses("lease_runner", one({ runner: "0x" + "33".repeat(32) }));
  await refuses("lease_runner", one({ runner: undefined }));
  await refuses("quiesce", one({}, EXPIRED + 1));                                       // root's expiry is not the chain's
});

test("cold facts: missing, false, malformed, extra fields, short stop window, and the unchanged quiesce checks refuse", async () => {
  await refuses("cold_quiesce", { quiesce: quiesce({ cold: undefined }) });
  await refuses("cold_quiesce", { quiesce: quiesce({ cold: cold({ profile: "metal0-cold-shutdown-c9-funding/v0" }) }) });
  await refuses("cold_quiesce", { quiesce: quiesce({ cold: cold({ preservationReceiptSha256: "" }) }) });
  await refuses("cold_quiesce", { quiesce: quiesce({ cold: cold({ noGuestUnits: false }) }) });
  await refuses("cold_quiesce", { quiesce: quiesce({ cold: cold({ noGuestRecords: "true" }) }) });
  await refuses("cold_quiesce", { quiesce: quiesce({ cold: cold({ stoppedAtSec: undefined }) }) });
  await refuses("cold_quiesce", { quiesce: quiesce({ cold: cold({ stoppedAtSec: TS - 30 }) }) });   // after root provided the facts
  await refuses("cold_quiesce", { quiesce: quiesce({ cold: cold({ fixture: true }) }) });
  const { noGuestUnits, ...partial } = cold(); await refuses("cold_quiesce", { quiesce: quiesce({ cold: partial }) });
  await refuses("cold_stop_window", { quiesce: quiesce({ providedAt: TS - 10, cold: cold({ stoppedAtSec: TS - 359 }) }) });
  await refuses("quiesce", { quiesce: quiesce({ providedBy: "worker" }) });
  await refuses("quiesce", { quiesce: quiesce({ signersStopped: [] }) });
  await refuses("quiesce", { quiesce: quiesce({ providedAt: TS - 7200 }) });
  await refuses("quiesce", { quiesce: quiesce({ lastSponsoredLeaseDeadline: TS - 60 }) });          // deadline + 60 s not passed
  await refuses("sponsor_balance", { facts: facts({ sponsorBalance: "6000000000000" }) });
  await refuses("profile", { profile: "COLD" });
});

test("profile binding: a live plan never passes the cold checks and vice versa; a changed profile refuses; no cold fixture", async () => {
  const coldPlan = JSON.parse((await build()).text);
  const live = await buildPlan({ cfg: P, facts: facts({}, { [ID1]: lease({ leaseUntil: TS + 1500 }) }), quiesce: quiesce({ cold: undefined, leases: [{ id: ID1, expiry: TS + 1500 }] }), oracle: oracle() });
  const livePlan = JSON.parse(live.text);
  const planRefuses = (plan, profile) => assert.throws(() => checkExecutablePlan(P, plan, profile), (e) => e instanceof Refusal && /^plan/.test(e.code));
  assert.doesNotThrow(() => checkExecutablePlan(P, livePlan, "live"));
  planRefuses(coldPlan, "live"); planRefuses(livePlan, "cold");
  planRefuses({ ...coldPlan, kind: livePlan.kind }, "live");                                    // relabelled kind still carries the cold profile
  planRefuses({ ...livePlan, kind: coldPlan.kind, profile: coldPlan.profile }, "cold");         // no cold facts
  planRefuses({ ...coldPlan, profile: { ...coldPlan.profile, sha256: "0x" + "00".repeat(32) } }, "cold");
  planRefuses({ ...coldPlan, profile: { ...coldPlan.profile, marker: "other" } }, "cold");
  planRefuses({ ...coldPlan, profile: undefined }, "cold");
  planRefuses({ ...coldPlan, quiesce: { ...coldPlan.quiesce, cold: undefined } }, "cold");
  assert.throws(() => checkExecutablePlan(P, coldPlan, "warm"), Refusal);

  const approval = (planHash, extra) => JSON.stringify({ approvedBy: "root", planHash, timingProfileSha256: coldPlan.timing.sha256, chainId: P.chainId, operator: P.operator,
    executor: P.executor, sponsor: P.sponsor, valueWei: P.valueWei.toString(), feeCapWei: P.feeCapWei.toString(), expiresAt: TS + 600,
    humanApprovals: [{ role: "c9-key-holder", by: "x", at: "t" }, { role: "sponsor-owner", by: "y", at: "t" }], ...extra });
  const ok = (text, profile) => checkApproval(P, null, "0x" + sha256(profileText(profile)), text, "0x" + sha256(text), TS, profile);
  const profileText = (profile) => (profile === "cold" ? coldText : live.text);
  const coldText = (await build()).text;
  const coldPlanHash = "0x" + sha256(coldText), livePlanHash = "0x" + sha256(live.text);
  const coldApproval = approval(coldPlanHash, { kind: COLD_APPROVAL_KIND, profile: COLD.marker, coldProfileSha256: coldProfileSha256() });
  const liveApproval = approval(livePlanHash, { kind: APPROVAL_KIND });
  assert.doesNotThrow(() => ok(coldApproval, "cold")); assert.doesNotThrow(() => ok(liveApproval, "live"));
  const approvalRefuses = (text, profile) => assert.throws(() => ok(text, profile), (e) => e instanceof Refusal && e.code === "approval");
  approvalRefuses(coldApproval, "live"); approvalRefuses(liveApproval, "cold");
  approvalRefuses(approval(livePlanHash, { kind: APPROVAL_KIND, profile: COLD.marker, coldProfileSha256: coldProfileSha256() }), "live");
  approvalRefuses(approval(coldPlanHash, { kind: COLD_APPROVAL_KIND, profile: COLD.marker }), "cold");
  approvalRefuses(approval(coldPlanHash, { kind: COLD_APPROVAL_KIND, profile: COLD.marker, coldProfileSha256: "0x" + "00".repeat(32) }), "cold");
  approvalRefuses(approval(coldPlanHash, { kind: APPROVAL_KIND, profile: COLD.marker, coldProfileSha256: coldProfileSha256() }), "cold");

  assert.throws(() => createPreparer({ profile: "cold", fixture: true }), /no fixture mode/);
  assert.throws(() => createSender({ profile: "cold", fixture: true, journalDir: "/nonexistent" }), /no fixture mode/);
  assert.throws(() => createPreparer({ profile: "cold", cfg: { ...P, valueWei: 6_000_000_000_000n } }), /production value/);
  await assert.rejects(createPreparer({ profile: "cold", rpc: { send: async () => assert.fail("no chain read before the inventory check") } }).prepare({ quiesce: quiesce({ leases: [{ id: ID1, expiry: EXPIRED }] }) }),
    (e) => e instanceof Refusal && e.code === "cold_inventory");
});
