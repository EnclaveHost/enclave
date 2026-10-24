// The ACTUAL EIP-7702 processing (anvil = revm, hardfork prague) for every path of the plan, with THROWAWAY keys only.
// O stands for C9, S for the sponsor, T for a third party, R for a lease relayer. Nothing here touches production.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { keccak256, encodeFunctionData, decodeFunctionResult, parseAbi, toFunctionSelector } from "viem";
import { startWorld, instantClock, quiesceFor, signPlanForTest, ID1, ID2, pad32 } from "./env.mjs";
import { createPreparer, designatorOf, nonceSlot, authorizedSlot, Refusal } from "../lib/maintenance.mjs";

let w;
before(async () => { w = await startWorld(); });
after(async () => { await w?.close(); });
beforeEach(async () => { await w.reset(); });

const VIEW = parseAbi(["function nonceOf(bytes32) view returns (uint64)", "function authorizationCharged() view returns (bool)"]);
const RES = parseAbi(["function delegationCodeHash() view returns (bytes32)"]);
const O = () => w.keys.O.address, S = () => w.keys.S.address;
const code = async () => (await w.raw("eth_getCode", [O(), "latest"])).toLowerCase();
const bal = async (a) => BigInt(await w.raw("eth_getBalance", [a, "latest"]));
const nonce = async () => Number(BigInt(await w.raw("eth_getTransactionCount", [O(), "latest"])));
const slotsNow = async () => Object.fromEntries(await Promise.all(Object.keys(w.slots).map(async (k) => [k, await w.raw("eth_getStorageAt", [O(), k, "latest"])])));
const view = async (fn, args = []) => decodeFunctionResult({ abi: VIEW, functionName: fn, data: await w.raw("eth_call", [{ to: O(), data: encodeFunctionData({ abi: VIEW, functionName: fn, args }) }, "latest"]) });
const receipt = (h) => w.raw("eth_getTransactionReceipt", [h]);
const send = (rawTx) => w.raw("eth_sendRawTransaction", [rawTx]);
async function plan(patch) { return (await createPreparer({ cfg: w.cfg, fixture: true, clock: instantClock() }).prepare({ quiesce: await quiesceFor(w, patch) })).plan; }
async function restoredAndPreserved() {
  assert.equal(await code(), designatorOf(w.executor)); assert.equal(keccak256(await code()), w.cfg.delegationCodeHash);
  assert.deepEqual(await slotsNow(), w.slots, "every storage slot unchanged");
  assert.equal(await view("nonceOf", [ID1]), 7n); assert.equal(await view("nonceOf", [ID2]), 3n); assert.equal(await view("authorizationCharged"), true);
  assert.equal(decodeFunctionResult({ abi: RES, functionName: "delegationCodeHash", data: await w.raw("eth_call", [{ to: w.stub, data: encodeFunctionData({ abi: RES, functionName: "delegationCodeHash" }) }, "latest"]) }), w.cfg.delegationCodeHash);
}

test("the read-only prepare: exact tuples, nonce rules, digests, observed storage, premise, fees within the cap", async () => {
  const p = await plan();
  const N = p.observed.operatorNonce, s = p.observed.sponsorNonce;
  assert.deepEqual(p.authorizationsToSign.map((a) => a.tuple), [{ chainId: 8453, address: "0x0000000000000000000000000000000000000000", nonce: Number(N) },
    { chainId: 8453, address: w.executor.toLowerCase(), nonce: Number(N) + 1 }]);
  assert.deepEqual(p.transactions.map((t) => [t.unsigned.nonce, t.unsigned.to, t.unsigned.value]), [[Number(s), O().toLowerCase(), "5000000000000"], [Number(s) + 1, S().toLowerCase(), "0"]]);
  assert.equal(p.observed.plainTransferReverts, true, "the premise: a plain transfer to the delegated operator reverts");
  assert.match(p.observed.codelessTransferSimulation, /succeeds/);
  assert.equal(p.observed.storage.nonces[ID1], pad32(7)); assert.equal(p.observed.executorViews.nonceOf[ID1], "7"); assert.equal(p.observed.executorViews.authorizationCharged, true);
  assert.ok(BigInt(p.fees.totalBoundWei) <= 2_000_000_000_000n);
  for (const t of p.transactions) assert.ok(t.encodedBytes.argument + 68 >= t.encodedBytes.signedMax);
  // what the operator's key would sign is exactly the plan's digest
  const { auths } = await signPlanForTest(p, w.keys.O, w.keys.S);
  const { recoverAuthorizationAddress } = await import("viem/utils");
  for (const [i, a] of auths.entries()) assert.equal((await recoverAuthorizationAddress({ authorization: a })).toLowerCase(), O().toLowerCase(), `auth ${i}`);
});

test("happy path, actual processing: after A C9 is codeless and funded with storage intact; after B restored byte-exactly", async () => {
  const p = await plan(); const N = Number(p.observed.operatorNonce);
  const { rawA, rawB } = await signPlanForTest(p, w.keys.O, w.keys.S);
  const b0 = await bal(O()), s0 = await bal(S());
  const hA = await send(rawA); await w.mine();
  const rA = await receipt(hA);
  assert.equal(rA.status, "0x1"); assert.equal(await code(), "0x"); assert.equal(await nonce(), N + 1);
  assert.equal(await bal(O()), b0 + 5_000_000_000_000n, "exactly V arrived");
  assert.deepEqual(await slotsNow(), w.slots, "storage untouched while codeless");
  const hB = await send(rawB); await w.mine();
  const rB = await receipt(hB);
  assert.equal(rB.status, "0x1"); assert.equal(await nonce(), N + 2);
  await restoredAndPreserved();
  const paid = s0 - (await bal(S()));
  assert.ok(paid - 5_000_000_000_000n <= BigInt(p.fees.totalBoundWei), "the sponsor paid V + at most the bounded fees");
  assert.ok(BigInt(rA.gasUsed) < BigInt(p.transactions[0].unsigned.gas) && BigInt(rB.gasUsed) < BigInt(p.transactions[1].unsigned.gas));
});

test("hazard between A and B: a relayed lease() call to the codeless C9 SUCCEEDS as a silent no-op; the same B then restores", async () => {
  const p = await plan();
  const { rawA, rawB } = await signPlanForTest(p, w.keys.O, w.keys.S);
  await send(rawA); await w.mine();
  const leaseSel = toFunctionSelector("lease((bytes32,uint8,bytes32,uint64,uint64,address,uint256),bytes)");
  const h = await w.sendRaw(w.keys.R, { type: "eip1559", nonce: await w.nonceOf(w.keys.R.address), to: O(), gas: 200_000n, data: leaseSel + "00".repeat(300) });
  await w.mine();
  const r = await receipt(h);
  assert.equal(r.status, "0x1", "no revert: a relayer would see success"); assert.equal(r.logs.length, 0, "nothing happened");
  assert.deepEqual(await slotsNow(), w.slots, "no nonce consumed, no renewal");
  await send(rawB); await w.mine();
  await restoredAndPreserved();
});

test("order is enforced by the sponsor's nonces: B submitted first still runs after A", async () => {
  const p = await plan();
  const { rawA, rawB } = await signPlanForTest(p, w.keys.O, w.keys.S);
  const hB = await send(rawB); const hA = await send(rawA); await w.mine();
  const [rA, rB] = [await receipt(hA), await receipt(hB)];
  assert.equal(rA.blockNumber, rB.blockNumber); assert.ok(BigInt(rA.transactionIndex) < BigInt(rB.transactionIndex));
  assert.equal(rA.status, "0x1"); assert.equal(rB.status, "0x1");
  await restoredAndPreserved();
});

test("reorg: the same signed bytes re-include to the same hashes and the same final state", async () => {
  const p = await plan();
  const { rawA, rawB } = await signPlanForTest(p, w.keys.O, w.keys.S);
  const snap = await w.raw("evm_snapshot");
  const h1 = [await send(rawA), await send(rawB)]; await w.mine();
  const end1 = { code: await code(), nonce: await nonce(), bal: await bal(O()) };
  await w.raw("anvil_dropAllTransactions"); await w.raw("evm_revert", [snap]);              // the blocks are gone
  assert.equal(await code(), designatorOf(w.executor));
  const h2 = [await send(rawA), await send(rawB)]; await w.mine();
  assert.deepEqual(h2, h1);
  assert.deepEqual({ code: await code(), nonce: await nonce(), bal: await bal(O()) }, end1);
  await restoredAndPreserved();
});

test("stale A (C9's nonce moved, still delegated): A reverts and V stays with the sponsor; B (now valid) only re-delegates", async () => {
  const p = await plan(); const N = Number(p.observed.operatorNonce);
  const { rawA, rawB } = await signPlanForTest(p, w.keys.O, w.keys.S);
  await w.raw("anvil_setBalance", [O(), "0x" + (10n ** 16n).toString(16)]);
  await w.sendRaw(w.keys.O, { type: "eip1559", nonce: N, to: w.keys.T.address, gas: 21_000n, value: 0n }); await w.mine();   // C9 sends something
  const b0 = await bal(O()), s0 = await bal(S());
  const hA = await send(rawA); await w.mine();
  const rA = await receipt(hA);
  assert.equal(rA.status, "0x0", "the call hit the executor (no receive/fallback) and reverted");
  assert.ok(BigInt(rA.gasUsed) < BigInt(p.transactions[0].unsigned.gas), "a revert, not out-of-gas");
  assert.equal(await bal(O()), b0, "V did not move"); assert.ok(s0 - (await bal(S())) < 5_000_000_000_000n, "the sponsor lost only gas");
  assert.equal(await code(), designatorOf(w.executor));
  const hB = await send(rawB); await w.mine();
  assert.equal((await receipt(hB)).status, "0x1"); assert.equal(await nonce(), N + 2, "B's authorization (N+1) applied: the same executor again");
  await restoredAndPreserved();
});

test("front-run: a third party applies A's authorization first; our A's authorization is skipped but its value call to the CODELESS C9 succeeds", async () => {
  const p = await plan(); const N = Number(p.observed.operatorNonce);
  const { rawA, rawB, auths } = await signPlanForTest(p, w.keys.O, w.keys.S);
  await w.sendRaw(w.keys.T, { type: "eip7702", nonce: await w.nonceOf(w.keys.T.address), to: w.keys.T.address, gas: 100_000n, authorizationList: [auths[0]] });
  await w.mine();
  assert.equal(await code(), "0x"); assert.equal(await nonce(), N + 1);
  const b0 = await bal(O());
  const hA = await send(rawA); await w.mine();
  assert.equal((await receipt(hA)).status, "0x1", "NOT a revert: the account is already codeless");
  assert.equal(await bal(O()), b0 + 5_000_000_000_000n, "C9 funded although our authorization did not apply");
  assert.equal(await nonce(), N + 1, "our stale authorization did not bump the nonce");
  await send(rawB); await w.mine();
  await restoredAndPreserved();
});

test("front-run + the lease client's own authorization: our A reverts, our B is skipped; C9 ends delegated and unfunded (re-plan)", async () => {
  const p = await plan(); const N = Number(p.observed.operatorNonce);
  const { rawA, rawB, auths } = await signPlanForTest(p, w.keys.O, w.keys.S);
  await w.sendRaw(w.keys.T, { type: "eip7702", nonce: await w.nonceOf(w.keys.T.address), to: w.keys.T.address, gas: 100_000n, authorizationList: [auths[0]] });
  await w.mine();
  // client/lease-executor-client.mjs 463/573: a not-delegated operator signs a NEW authorization to the executor; a relay includes it
  const clientAuth = await w.keys.O.signAuthorization({ chainId: 8453, contractAddress: w.executor, nonce: N + 1 });
  await w.sendRaw(w.keys.R, { type: "eip7702", nonce: await w.nonceOf(w.keys.R.address), to: w.keys.R.address, gas: 100_000n, authorizationList: [clientAuth] });
  await w.mine();
  assert.equal(await code(), designatorOf(w.executor)); assert.equal(await nonce(), N + 2);
  const b0 = await bal(O());
  const hA = await send(rawA), hB = await send(rawB); await w.mine();
  assert.equal((await receipt(hA)).status, "0x0"); assert.equal((await receipt(hB)).status, "0x1");
  assert.equal(await bal(O()), b0, "unfunded"); assert.equal(await nonce(), N + 2, "B's stale authorization was skipped");
  await restoredAndPreserved();
});

test("interruption: A mined, then C9's nonce moves (it is codeless and funded): B is stale; recovery = C9 self-restores (nonce = current + 1)", async () => {
  const p = await plan(); const N = Number(p.observed.operatorNonce);
  const { rawA, rawB } = await signPlanForTest(p, w.keys.O, w.keys.S);
  await send(rawA); await w.mine();
  await w.raw("anvil_setBalance", [O(), "0x" + (10n ** 16n).toString(16)]);                     // pays for its own transactions here
  await w.sendRaw(w.keys.O, { type: "eip1559", nonce: N + 1, to: w.keys.T.address, gas: 21_000n, value: 0n }); await w.mine();
  const hB = await send(rawB); await w.mine();
  assert.equal((await receipt(hB)).status, "0x1"); assert.equal(await code(), "0x", "B's authorization (N+1) was stale: still codeless");
  // the documented recovery: a self-executed type-4 transaction, authorization nonce = the account's nonce + 1
  const n = await nonce();
  const selfAuth = await w.keys.O.signAuthorization({ chainId: 8453, contractAddress: w.executor, nonce: n + 1 });
  const h = await w.sendRaw(w.keys.O, { type: "eip7702", nonce: n, to: O(), gas: 100_000n, authorizationList: [selfAuth] });
  await w.mine();
  assert.equal(await code(), designatorOf(w.executor)); assert.equal(await nonce(), n + 2);
  await restoredAndPreserved();
  void h;
});

test("an authorization for another chain is skipped: A reverts, nothing moves (and the plan refuses chain id 0)", async () => {
  const p = await plan(); const N = Number(p.observed.operatorNonce);
  const wrong = await w.keys.O.signAuthorization({ chainId: 1, contractAddress: "0x0000000000000000000000000000000000000000", nonce: N });
  const u = p.transactions[0].unsigned;
  const b0 = await bal(O());
  const h = await w.sendRaw(w.keys.S, { type: "eip7702", nonce: Number(u.nonce), to: u.to, value: BigInt(u.value), gas: BigInt(u.gas), authorizationList: [wrong] });
  await w.mine();
  assert.equal((await receipt(h)).status, "0x0"); assert.equal(await bal(O()), b0); assert.equal(await code(), designatorOf(w.executor)); assert.equal(await nonce(), N);
  const { checkConfig } = await import("../lib/maintenance.mjs");
  assert.throws(() => checkConfig({ ...w.cfg, chainId: 0 }), /never 0/);
});

test("prepare refusals against the live local chain: not delegated, other target, pending nonce, sponsor with code, fee cap, quiesce, lease window", async () => {
  const refuses = async (code_, fn, patch) => { await w.reset(); await fn?.(); await assert.rejects(plan(patch), (e) => (e instanceof Refusal && e.code === code_) || assert.fail(`${code_}: ${e.code} ${e.message}`)); };
  await refuses("operator_code", async () => { await w.raw("anvil_setCode", [O(), "0x"]); await w.mine(3); });
  await refuses("operator_code", async () => { await w.raw("anvil_setCode", [O(), designatorOf(w.stub)]); await w.mine(3); });
  await refuses("nonce", async () => { await w.mine(3); await w.raw("anvil_setBalance", [O(), "0x" + (10n ** 16n).toString(16)]); await w.sendRaw(w.keys.O, { type: "eip1559", nonce: await w.nonceOf(O()), to: w.keys.T.address, gas: 21_000n }); });
  await refuses("sponsor_code", async () => { await w.raw("anvil_setCode", [S(), designatorOf(w.executor)]); await w.mine(3); });
  await refuses("fee_cap", async () => { w.state.tip = "0x" + (25_000_000n).toString(16); });
  await refuses("quiesce", null, { lastSponsoredLeaseDeadline: Math.floor(Date.now() / 1000) + 600 });
  await refuses("quiesce", null, { signersStopped: [] });
  await refuses("lease_window", null, { leases: [{ id: ID1, expiry: Math.floor(Date.now() / 1000) + 600 }] });
  await w.reset();
  assert.throws(() => createPreparer({ cfg: w.cfg }), /production value/, "the CLI path only ever accepts production pins");
});

test("gas limits cover every path with margin (measured on revm, not modelled)", async (t) => {
  const p = await plan(); const N = Number(p.observed.operatorNonce);
  const gA = BigInt(p.transactions[0].unsigned.gas), gB = BigInt(p.transactions[1].unsigned.gas);
  const { rawA, rawB, auths } = await signPlanForTest(p, w.keys.O, w.keys.S);
  const used = {};
  const hA = await send(rawA); await w.mine(); used.A_valid_transfer = BigInt((await receipt(hA)).gasUsed);
  const hB = await send(rawB); await w.mine(); used.B_valid_restore = BigInt((await receipt(hB)).gasUsed);
  // A with its authorization skipped and C9 delegated (the revert path), with a generous limit to see its true cost
  await w.reset();
  await w.raw("anvil_setBalance", [O(), "0x" + (10n ** 16n).toString(16)]);
  await w.sendRaw(w.keys.O, { type: "eip1559", nonce: N, to: w.keys.T.address, gas: 21_000n }); await w.mine();
  const u = p.transactions[0].unsigned;
  const h1 = await w.sendRaw(w.keys.S, { type: "eip7702", nonce: Number(u.nonce), to: u.to, value: BigInt(u.value), gas: 300_000n, authorizationList: [auths[0]] });
  await w.mine(); used.A_skipped_delegated_revert = BigInt((await receipt(h1)).gasUsed);
  // A with its authorization skipped and C9 codeless (the front-run path)
  await w.reset();
  await w.sendRaw(w.keys.T, { type: "eip7702", nonce: await w.nonceOf(w.keys.T.address), to: w.keys.T.address, gas: 100_000n, authorizationList: [auths[0]] }); await w.mine();
  const h2 = await w.sendRaw(w.keys.S, { type: "eip7702", nonce: Number(u.nonce), to: u.to, value: BigInt(u.value), gas: 300_000n, authorizationList: [auths[0]] });
  await w.mine(); used.A_skipped_codeless_transfer = BigInt((await receipt(h2)).gasUsed);
  for (const [k, v] of Object.entries(used)) assert.ok(v > 0n && v < (k.startsWith("A") ? gA : gB), `${k} used ${v}`);
  t.diagnostic("gas used " + JSON.stringify(Object.fromEntries(Object.entries(used).map(([k, v]) => [k, v.toString()]))) + ` limits A ${gA} B ${gB}`);
});
