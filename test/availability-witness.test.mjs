// The capacity witness (availability/witness.mjs) and the host acceptor (availability/host-acceptor.mjs).
//   run: node --test test/availability-witness.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createWitness } from "../availability/witness.mjs";
import { verifyReceipt } from "../availability/evidence.mjs";
import { createHostAcceptor } from "../availability/host-acceptor.mjs";

const FEES = "0x87c7266543ff5839b2c20226BD9B3cd511A23641", EP = "https://api.enclave.host/t/metal0";
const HOST = keccak256(toBytes(EP)).toLowerCase();
const OP = "0x" + "c9".repeat(20), PAY = "0x" + "0b".repeat(20), CHIP = "ab".repeat(64);

function rig({ active = true, quoteOk = true, units = 552, spare = 17, audit = null } = {}) {
  const signer = privateKeyToAccount(generatePrivateKey());
  const mem = new Map();
  let t = 1_800_000_000n;
  const w = createWitness({ signer, chainId: 8453, contract: FEES, allowedMeasurements: ["aa".repeat(48)], minTcb: {},
    readRegistry: async (id) => (id === HOST ? { active, operator: OP, payoutWallet: PAY, cpuPricePerSec6: 1104n } : null),
    verifyQuote: async () => (quoteOk ? { ok: true, measurement: "aa".repeat(48), chipId: CHIP } : { ok: false, reason: "measurement not allowed" }),
    lastAudit: async () => audit, state: { get: (k) => mem.get(k) || null, set: (k, v) => mem.set(k, v) }, now: () => t, log: () => {} });
  const host = { endpoint: EP, attest: async () => ({ report: Buffer.alloc(1), auxblob: null, binding: Buffer.alloc(32), evidence: "test" }),
                 availability: async () => ({ nodeGflops: units, cpuGflopsFree: spare }) };
  return { w, host, signer, advance: (s) => { t += BigInt(s); }, now: () => t };
}

test("witness: a verified host gets a signed operator-bootstrap capacity receipt the observation accepts", async () => {
  const r = rig();
  const { receipts, refused } = await r.w.round([r.host]);
  assert.equal(refused.length, 0); assert.equal(receipts.length, 1);
  const p = await verifyReceipt(receipts[0], { chainId: 8453, contract: FEES, signers: { [r.signer.address.toLowerCase()]: "enclave" }, quorum: 1,
                                               nowSec: r.now(), kind: "capacity", hostOperator: OP, trustMode: "operator-bootstrap" });
  assert.deepEqual([p.hostId, p.operator, p.payoutWallet, p.units, p.spareUnits, p.minimumRate6, p.trustMode], [HOST, OP, PAY, "552", "17", "2", "operator-bootstrap"]);
  assert.match(p.hardwareId, /^0x[0-9a-f]{64}$/);
  await assert.rejects(verifyReceipt(receipts[0], { chainId: 8453, contract: FEES, signers: { [r.signer.address.toLowerCase()]: "enclave" }, quorum: 2,
                                                    nowSec: r.now(), kind: "capacity", hostOperator: OP, trustMode: "independent" }), "never counts as independent");
});

test("witness: qualification is continuous - issuedSec stays at the first pass, and restarts after a gap", async () => {
  const r = rig();
  const first = (await r.w.round([r.host])).receipts[0].payload.issuedSec;
  r.advance(600);
  assert.equal((await r.w.round([r.host])).receipts[0].payload.issuedSec, first, "still the first pass");
  r.advance(7 * 3600);   // longer than the receipt lifetime without a round
  assert.notEqual((await r.w.round([r.host])).receipts[0].payload.issuedSec, first, "a gap starts a new run");
});

test("witness: no receipt for an inactive registry entry, a refused quote, bad capacity, or a failed last audit", async () => {
  for (const [opts, why] of [[{ active: false }, /not active/], [{ quoteOk: false }, /attestation/], [{ units: 0 }, /out of bounds/],
                             [{ spare: 600 }, /out of bounds/], [{ audit: { passed: false } }, /audit failed/]]) {
    const r = rig(opts);
    const { receipts, refused } = await r.w.round([r.host]);
    assert.equal(receipts.length, 0); assert.match(refused[0].reason, why);
  }
});

test("acceptor: offers exactly the job's own rate for an approved audit on THIS host, and nothing else", async () => {
  const REF = "catalog://0x962622b0284b438f58ad480b824d4fbf7fa9ce3dc84e2af97b65bd15392a5e6f/0";
  const sent = [];
  let job = ["0x" + "11".repeat(32), "0x" + "22".repeat(20), HOST, 1n, 1_900_000_000n, 20n, 12000n, false, 0n], dep = { appRef: REF, cpuMilli: 19 };
  const publicClient = { readContract: async ({ functionName }) => (functionName === "jobs" ? job : dep), waitForTransactionReceipt: async () => ({ status: "success" }) };
  const accept = createHostAcceptor({ publicClient, operatorWallet: { writeContract: async (x) => { sent.push(x); return "0xhash"; } }, ledger: "0x" + "dd".repeat(20),
    fees: FEES, enclaveId: HOST, appRefs: [REF], minRatePerShareMilli6: 1n, now: () => 1_800_000_000n, log: () => {} });
  const id = "0x" + "33".repeat(32);
  await accept({ id, hostId: HOST, rate6: 20n, expiresSec: 1_900_000_000n });
  assert.deepEqual(sent[0].args, [id, HOST, 20n, 1_900_000_000n]); assert.equal(sent[0].functionName, "offerJobRate");
  await assert.rejects(accept({ id, hostId: "0x" + "44".repeat(32), rate6: 20n, expiresSec: 1_900_000_000n }), /another host/);
  await assert.rejects(accept({ id, hostId: HOST, rate6: 21n, expiresSec: 1_900_000_000n }), /own rate/);
  dep = { appRef: "catalog://0x" + "55".repeat(32) + "/0", cpuMilli: 19 };
  await assert.rejects(accept({ id, hostId: HOST, rate6: 20n, expiresSec: 1_900_000_000n }), /not an approved audit/);
  dep = { appRef: REF, cpuMilli: 19 };
  job = [...job]; job[5] = 10n;
  await assert.rejects(accept({ id, hostId: HOST, rate6: 10n, expiresSec: 1_900_000_000n }), /floor/);
  job = [...job]; job[5] = 20n; job[7] = true;
  await assert.rejects(accept({ id, hostId: HOST, rate6: 20n, expiresSec: 1_900_000_000n }), /already funded/);
  job = [...job]; job[7] = false; job[2] = "0x" + "66".repeat(32);
  await assert.rejects(accept({ id, hostId: HOST, rate6: 20n, expiresSec: 1_900_000_000n }), /another host/);
  assert.equal(sent.length, 1);
});
