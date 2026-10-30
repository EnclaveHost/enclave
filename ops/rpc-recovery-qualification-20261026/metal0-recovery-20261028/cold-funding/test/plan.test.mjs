// The pure plan builder with PRODUCTION pins and synthetic facts (no chain, no key): nonce rules, the exact V, the
// aggregate fee cap (refuse, never raise), the sponsor's balance, quiesce and config refusals, determinism.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashAuthorization } from "viem/utils";
import { PRODUCTION, buildPlan, checkConfig, createPreparer, designatorOf, authorizations, Refusal, RECOVERY, LIMITS } from "../lib/maintenance.mjs";

const P = PRODUCTION, TS = 1_792_800_000;
const facts = (patch = {}) => ({ block: "53005000", blockHash: "0x" + "ab".repeat(32), blockTimestamp: TS, rpcs: ["a", "b"],
  operatorCode: designatorOf(P.executor), sponsorCode: "0x", executorCodeHash: P.executorCodeHash, reserveCodeHash: P.reserveCodeHash,
  reserveExecutor: P.executor, reserveDelegationCodeHash: P.delegationCodeHash, ledgerCodeHash: P.ledgerCodeHash,
  leases: { ["0x"+"da".repeat(32)]: {active:true, runnerOperator:P.operator, leaseUntil:TS+1500, rate:"0"}}, leaseSec:"1800",
  operatorNonce: { atBlock: 23760, latest: 23760, pending: 23760 }, sponsorNonce: { atBlock: 41, latest: 41, pending: 41 },
  operatorBalance: "145368427115", sponsorBalance: "61650000000000", storage: {}, executorViews: {}, plainTransferReverts: true,
  codelessTransferSimulation: "n/a", baseFeePerGas: 5_000_000n, maxPriorityFeePerGas: 1_000_000n, ...patch });
const quiesce = (patch = {}) => ({ providedBy: "root", providedAt: TS - 60, signersStopped: ["metal0 control", "lease keeper"], lastSponsoredLeaseDeadline: TS - 900,
  leases: [{ id: "0x" + "da".repeat(32), expiry: TS + 1500 }], ...patch });
const oracle = (l1 = 50_000_000_000n, isthmus = true) => ({ isIsthmus: async () => isthmus, l1UpperBound: async () => l1, operatorFee: async (g) => BigInt(g) * 0n });
const refuses = (code, args) => assert.rejects(buildPlan({ cfg: P, facts: facts(), quiesce: quiesce(), oracle: oracle(), ...args }), (e) => (e instanceof Refusal && e.code === code) || assert.fail(`${code}: ${e.code} ${e.message}`));

test("production pins: C9 and ONLY the same executor; V exact; aggregate cap; chain 8453; separate sponsor", () => {
  assert.equal(P.operator, "0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab"); assert.equal(P.executor, "0x8900baca2167873ba2f8a8bae8b4876e6396d343");
  assert.equal(P.sponsor, "0x29479bf04ed889d46a7afb7f292b9bb26e12647c"); assert.equal(P.valueWei, 5_000_000_000_000n); assert.equal(P.feeCapWei, 2_000_000_000_000n);
  assert.equal(P.chainId, 8453); assert.doesNotThrow(() => checkConfig(P));
  for (const bad of [{ chainId: 0 }, { sponsor: P.operator }, { delegationCodeHash: "0x" + "00".repeat(32) }]) assert.throws(() => checkConfig({ ...P, ...bad }), Refusal);
  assert.throws(() => createPreparer({ cfg: { ...P, valueWei: 6_000_000_000_000n } }), /production value/);
  assert.throws(() => createPreparer({ cfg: { ...P, feeCapWei: 3_000_000_000_000n } }), /production value/);
  assert.throws(() => createPreparer({ cfg: { ...P, executor: "0x" + "11".repeat(20) } }));
});

test("the unsigned plan at today's numbers: nonces N/N+1 and s/s+1, digests, worst-case sizes, fees within the cap", async () => {
  const { plan, planHash, text } = await buildPlan({ cfg: P, facts: facts(), quiesce: quiesce(), oracle: oracle() });
  const [a, b] = plan.authorizationsToSign;
  assert.deepEqual(a.tuple, { chainId: 8453, address: "0x0000000000000000000000000000000000000000", nonce: 23760 });
  assert.deepEqual(b.tuple, { chainId: 8453, address: P.executor, nonce: 23761 });
  assert.equal(a.digest, hashAuthorization({ chainId: 8453, address: "0x0000000000000000000000000000000000000000", nonce: 23760 }));
  assert.deepEqual(plan.transactions.map((t) => [t.unsigned.nonce, t.unsigned.to, t.unsigned.value, t.unsigned.gas]), [[41, P.operator, "5000000000000", "50000"], [42, P.sponsor, "0", "47000"]]);
  assert.equal(plan.verifyAfterA.operatorNonce, "23761"); assert.equal(plan.verifyAfterB.operatorNonce, "23762"); assert.equal(plan.verifyAfterB.operatorCodeHash, P.delegationCodeHash);
  assert.ok(BigInt(plan.fees.totalBoundWei) <= P.feeCapWei);
  assert.match(plan.status, /UNSIGNED/); assert.ok(plan.recovery.length === RECOVERY.length && plan.limits.length === LIMITS.length);
  assert.match(JSON.stringify(plan.quiesce), /463-464, 573-574/);
  assert.equal(planHash, (await buildPlan({ cfg: P, facts: facts(), quiesce: quiesce(), oracle: oracle() })).planHash, "deterministic");
  assert.ok(!/privateKey|registryKey":\s*"0x/.test(text), "no key material");
});

test("fees: the aggregate cap refuses (never raises); the base-fee edge is computed, not guessed", async () => {
  // L2 = (50000 + 47000) * (2 * base + tip); with L1 0 and operator 0 the cap allows maxFeePerGas <= 2e12 / 97000
  const maxFee = 2_000_000_000_000n / 97_000n, tip = 1_000_000n, edgeBase = (maxFee - tip) / 2n;
  await assert.doesNotReject(buildPlan({ cfg: P, facts: facts({ baseFeePerGas: edgeBase }), quiesce: quiesce(), oracle: oracle(0n) }));
  await refuses("fee_cap", { facts: facts({ baseFeePerGas: edgeBase + 1n }), oracle: oracle(0n) });
  await refuses("fee_cap", { oracle: oracle(1_500_000_000_000n) });                         // a large L1 bound alone
  await refuses("operator_fee", { oracle: oracle(0n, false) });
  await refuses("sponsor_balance", { facts: facts({ sponsorBalance: "6000000000000" }) });  // < V + fees
});

test("state refusals: not delegated, another target, sponsor code, unbound reserve, other runtimes, unsettled nonces, premise", async () => {
  await refuses("operator_code", { facts: facts({ operatorCode: "0x" }) });
  await refuses("operator_code", { facts: facts({ operatorCode: designatorOf("0x" + "11".repeat(20)) }) });
  await refuses("sponsor_code", { facts: facts({ sponsorCode: designatorOf(P.executor) }) });
  await refuses("reserve_binding", { facts: facts({ reserveExecutor: "0x" + "22".repeat(20) }) });
  await refuses("executor_code", { facts: facts({ executorCodeHash: "0x" + "33".repeat(32) }) });
  await refuses("reserve_code", { facts: facts({ reserveCodeHash: "0x" + "44".repeat(32) }) });
  await refuses("nonce", { facts: facts({ operatorNonce: { atBlock: 23760, latest: 23760, pending: 23761 } }) });
  await refuses("nonce", { facts: facts({ sponsorNonce: { atBlock: 40, latest: 41, pending: 41 } }) });
  await refuses("premise", { facts: facts({ plainTransferReverts: false }) });
});

test("quiesce refusals: root-provided only, signers listed, fresh, deadlines past on chain, leases with enough time", async () => {
  await refuses("quiesce", { quiesce: null });
  await refuses("quiesce", { quiesce: quiesce({ providedBy: "worker" }) });
  await refuses("quiesce", { quiesce: quiesce({ signersStopped: [] }) });
  await refuses("quiesce", { quiesce: quiesce({ providedAt: TS - 7200 }) });
  await refuses("quiesce", { quiesce: quiesce({ lastSponsoredLeaseDeadline: TS - 30 }) });
  await refuses("lease_window", { facts: facts({leases:{["0x"+"da".repeat(32)]:{active:true,runnerOperator:P.operator,leaseUntil:TS+1199,rate:"0"}}}), quiesce: quiesce({ leases: [{ id: "0x" + "da".repeat(32), expiry: TS + 1199 }] }) });
  await assert.doesNotReject(buildPlan({ cfg: P, facts: facts(), quiesce: quiesce({ leases: [] }), oracle: oracle() }));
});

test("authorizations are exactly two, for C9 only, with the sponsor-executed nonce rule", () => {
  const a = authorizations(P, 100);
  assert.equal(a.length, 2); assert.ok(a.every((x) => x.signer === P.operator));
  assert.deepEqual(a.map((x) => x.tuple.nonce), [100, 101]); assert.deepEqual(a.map((x) => x.tuple.chainId), [8453, 8453]);
});
