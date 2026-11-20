// Automatic lease-gas refill (sdk/funding-node/refill.mjs, sdk/funding-node/node-store.mjs): the refill decision, the grant terms
// it may offer the owner, the Node store a daemon keeps its session key and journal in, and one pass's orchestration
// (reconcile first, never pay while anything is unresolved, at most one refill, lowest runway first).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { concat, encodeAbiParameters, keccak256, recoverTypedDataAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fundingConfig, predictVault } from "../sdk/funding/funding-codec.mjs";
import { gasRecordId, newGasRecord, signerFor } from "../sdk/funding/v2-store.mjs";
import { FileV2Store } from "../sdk/funding-node/node-store.mjs";
import { buildRefillGrant, buildRefillTopUp, refillNeed, refillOnce, refillTerms, REFILL_LIMITS } from "../sdk/funding-node/refill.mjs";
import { EXEC_SCHEMA } from "../sdk/funding/gas-execution.mjs";
import { failoverRpc, usdc6 } from "../cli/gas-refill.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "refill-"));
const A = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const H = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const RENEW = 1_386_930_418_318n, CLAIM = 2_288_400_237_629n;      // live quotes at 0.006 gwei, 2026-11-11

function cfg(owner = A(0x0b2d)) {
  const factory = A(0xf1), implementation = A(0xf2);
  return fundingConfig({ chainId: 8453, factory, implementation, vault: predictVault(factory, implementation, owner), owner,
    gasAdapter: A(0xf3), legacyFactory: A(0xf4), legacyVault: A(0xf5), adapterMaxEthOut: 1_000_000_000_000_000n, adapterFeeTiers: [100, 500, 3000] });
}

test("refillNeed: refills below the low-water mark, up to the target, never above the per-op cap", () => {
  const perDay = (86_400n * RENEW + 1799n) / 1800n;                 // 48 renews a day
  const full = refillNeed({ balanceWei: perDay * 5n, renewWei: RENEW, claimWei: CLAIM, leaseSec: 1800n, maxEthPerOp: 200_000_000_000_000n });
  assert.equal(full.due, false);
  assert.equal(full.perDayWei, perDay);
  const low = refillNeed({ balanceWei: 786_527_660_168n, renewWei: RENEW, claimWei: CLAIM, leaseSec: 1800n, maxEthPerOp: 10n ** 15n });
  assert.equal(low.due, true);
  assert.equal(low.ethOut, perDay * 7n - 786_527_660_168n);         // to 7 days (0.00047 ETH), under a 0.001 ETH cap
  const step = refillNeed({ balanceWei: 786_527_660_168n, renewWei: RENEW, claimWei: CLAIM, leaseSec: 1800n, maxEthPerOp: 200_000_000_000_000n });
  assert.equal(step.ethOut, 200_000_000_000_000n);                  // the default cap: ~3 days per refill, the next pass tops up again
  const capped = refillNeed({ balanceWei: 0n, renewWei: RENEW, claimWei: CLAIM, leaseSec: 1800n, maxEthPerOp: 100_000_000_000_000n });
  assert.equal(capped.ethOut, 100_000_000_000_000n);
  const lapsed = refillNeed({ balanceWei: 0n, renewWei: RENEW, claimWei: CLAIM, leaseSec: 1800n, maxEthPerOp: 10n ** 18n, leaseLive: false });
  assert.equal(lapsed.ethOut, CLAIM + perDay * 7n);                   // a lapsed lease pays its claim first
  assert.throws(() => refillNeed({ balanceWei: 0n, renewWei: 0n, claimWei: CLAIM, leaseSec: 1800n, maxEthPerOp: 1n }), /bad refill inputs/);
});

test("refill grant terms: defaults fit the ceilings, overrides above a ceiling are refused, never clamped", () => {
  const t = refillTerms();
  assert.ok(t.maxGasUsdcPerOp + t.maxFeePerOp <= t.spendPerPeriod6);
  assert.equal(refillTerms({ budget6: "20000000" }).budget6, 20_000_000n);
  assert.throws(() => refillTerms({ budget6: REFILL_LIMITS.budget6 + 1n }), /budget6 must be/);
  assert.throws(() => refillTerms({ maxUsdcPerEth6: 0 }), /maxUsdcPerEth6 must be/);
  assert.throws(() => refillTerms({ spendPerPeriod6: 100_000n }), /must fit in a period/);
  assert.throws(() => refillTerms({ unknown: 1 }), /unknown refill term/);
});

test("buildRefillGrant: exactly gas.fund over the named apps, expiring after the chosen days", () => {
  const c = cfg();
  const now = 1_794_400_000n;
  const g = buildRefillGrant(c, { now, sessionKey: H(7), appIds: [H(0xb), H(0xa)], grantNonce: H(9), signBefore: now + 900n, terms: { days: 30 } });
  assert.equal(g.actionsMask, 1n << 10n);
  assert.deepEqual(g.typedData.message.apps, [H(0xa), H(0xb)]);
  assert.equal(g.typedData.message.preset, "gas-refill");
  assert.equal(g.typedData.message.expiresAt, now + 30n * 86_400n);
  assert.throws(() => buildRefillGrant(c, { now, sessionKey: H(7), appIds: [], grantNonce: H(9), signBefore: now + 900n }), /app ids required/);
  assert.throws(() => buildRefillGrant(c, { now, sessionKey: H(7), appIds: [H(1), H(1)], grantNonce: H(9), signBefore: now + 900n }), /distinct/);
});

async function openRecord(store, c, apps = [H(0xa)]) {
  const key = await store.newKey();
  const rec = newGasRecord({ key, chainId: 8453, relay: "https://relay.test", owner: c.owner, vault: c.vault, factory: c.factory,
    implementation: c.implementation, label: "t", now: 1 });
  const g = buildRefillGrant(c, { now: 1_794_400_000n, sessionKey: key.keyHash, appIds: apps, grantNonce: H(9), signBefore: 1_794_400_900n });
  Object.assign(rec, { grant: JSON.parse(JSON.stringify(g.typedData.message, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    grantDigest: g.digest, sid: g.sessionId, status: "open" });
  await store.saveKey(rec);
  return rec;
}

test("FileV2Store: the key survives a reload as a non-extractable signer; record files and journals hold no secret", async () => {
  const dir = tmp();
  fs.chmodSync(dir, 0o700);
  const c = cfg();
  const store = new FileV2Store(dir);
  const rec = await openRecord(store, c);
  const again = await new FileV2Store(dir).loadKey(rec.id);
  assert.equal(again.id, gasRecordId(rec.keyHash));
  assert.equal(again.privateKey.extractable, false);
  const sig = await signerFor(again.privateKey, BigInt(again.x), BigInt(again.y), webcrypto.subtle).signDigest(H(0x1234));
  const ok = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" },
    await webcrypto.subtle.importKey("raw", Buffer.from(`04${BigInt(rec.x).toString(16).padStart(64, "0")}${BigInt(rec.y).toString(16).padStart(64, "0")}`, "hex"),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    Buffer.from(sig.r.slice(2) + sig.s.slice(2), "hex"), Buffer.from(H(0x1234).slice(2), "hex"));
  assert.equal(ok, true);
  const recordText = fs.readFileSync(path.join(dir, "keys", `${rec.id}.json`), "utf8");
  assert.doesNotMatch(recordText, /privateKey|pkcs8/);
  const secret = fs.statSync(path.join(dir, "keys", `${rec.keyHash.slice(2)}.pkcs8`));
  assert.equal(secret.mode & 0o777, 0o600);
  await assert.rejects(store.putJournal({ id: "x:1", kind: "k", sig: "0x00" }), /may not be journaled/);
});

test("FileV2Store: casJournal never overwrites on a refused mutate, and refuses a group-readable directory", async () => {
  const dir = tmp();
  fs.chmodSync(dir, 0o700);
  const store = new FileV2Store(dir);
  await store.casJournal("gas-exec:a:1", () => ({ id: "gas-exec:a:1", status: "admitted" }));
  await assert.rejects(store.casJournal("gas-exec:a:1", (cur) => { if (cur) throw new Error("execute_exists"); return cur; }), /execute_exists/);
  assert.equal((await store.getJournal("gas-exec:a:1")).status, "admitted");
  assert.equal(fs.existsSync(path.join(dir, "journal.lock")), false);
  const open = tmp();
  fs.chmodSync(open, 0o755);
  assert.throws(() => new FileV2Store(open), /readable by others/);
});

function pass(store, record, reserves, api, scopeApps = {}) {
  const deployments = new Map(Object.keys(reserves).map((id) => [id, { appId: scopeApps[id] ?? H(0xa), holder: A(0x0b2d), env: 2, active: true }]));
  return refillOnce({ runtime: {}, store, record, relay: null, relayBase: "https://relay.test", rpc: null, subtle: webcrypto.subtle,
    scopeOf: async () => ({ deployments, timestamp: 1n }), reserveOf: async (id) => reserves[id], now: () => 1_794_400_100n, api });
}
const R = (balanceWei) => ({ balanceWei, renewWei: RENEW, claimWei: CLAIM, leaseSec: 1800n, leaseLive: true });

test("refillOnce: lowest runway first, exactly one refill per pass, the quote it got is the one confirmed", async () => {
  const dir = tmp(); fs.chmodSync(dir, 0o700);
  const store = new FileV2Store(dir);
  const record = await openRecord(store, cfg());
  const calls = [];
  const api = {
    reconcile: async () => { throw new Error("nothing to reconcile"); },
    quote: async (q) => { calls.push(["quote", q.deployment, q.ethOut]); return { tag: "Q", totals: { totalMaximum6: 500_000n } }; },
    confirm: async (c) => { calls.push(["confirm", c.review.tag]); return { pending: false, txHash: H(0xee), settlement: { actual: { totalDebit6: 480_000n } } }; },
  };
  const r = await pass(store, record, { [H(1)]: R(900_000_000_000n), [H(2)]: R(100_000_000_000n), [H(3)]: R(10n ** 15n) }, api);
  assert.equal(r.action, "paid");
  assert.equal(r.id, H(2));
  assert.deepEqual(calls.map((c) => c[0]), ["quote", "confirm"]);
  assert.equal(calls[1][1], "Q");
  const idle = await pass(store, record, { [H(3)]: R(10n ** 15n) }, api);
  assert.equal(idle.action, "idle");
});

test("refillOnce: an unresolved execution is reconciled read-only and, still unresolved, blocks any new spend", async () => {
  const dir = tmp(); fs.chmodSync(dir, 0o700);
  const store = new FileV2Store(dir);
  const record = await openRecord(store, cfg());
  await store.casJournal(`gas-exec:${record.sid}:5`, () => ({ id: `gas-exec:${record.sid}:5`, kind: "gas-execute", schema: EXEC_SCHEMA,
    sid: record.sid, status: "unknown", record: { id: record.id } }));
  let reconciled = 0, quoted = 0;
  const api = { reconcile: async () => { reconciled++; return { verdict: "still_unknown" }; }, quote: async () => { quoted++; }, confirm: async () => assert.fail("never") };
  const r = await pass(store, record, { [H(1)]: R(0n) }, api);
  assert.equal(r.action, "blocked");
  assert.equal(reconciled, 1);
  assert.equal(quoted, 0);
});

test("refillOnce: apps outside the grant and a refused quote pay nothing", async () => {
  const dir = tmp(); fs.chmodSync(dir, 0o700);
  const store = new FileV2Store(dir);
  const record = await openRecord(store, cfg());
  const api = { reconcile: async () => ({}), quote: async () => { const e = new Error("needs 900000, the session holds 10"); e.code = "quote_exceeds_budget"; throw e; },
    confirm: async () => assert.fail("never") };
  const outside = await pass(store, record, { [H(1)]: R(0n) }, api, { [H(1)]: H(0xbad) });
  assert.equal(outside.action, "idle");
  assert.equal(outside.rows[0].skipped, "app not in the refill grant");
  const refused = await pass(store, record, { [H(1)]: R(0n) }, api);
  assert.deepEqual([refused.action, refused.stage, refused.code], ["refused", "quote", "quote_exceeds_budget"]);
  assert.equal((await pass(store, { ...record, status: "reviewed" }, { [H(1)]: R(0n) }, api)).action, "blocked");
});

test("failoverRpc: a provider with no answer is skipped, a chain error is not retried elsewhere", async () => {
  const calls = [];
  const fake = (name, behave) => async (method) => { calls.push(name); return behave(method); };
  const rateLimited = Object.assign(new Error("rpc_error: eth_call: over rate limit"), { code: "rpc_error" });
  const reverted = Object.assign(new Error("rpc_error: eth_call: execution reverted"), { code: "rpc_error" });
  const makers = { "https://a.test": fake("a", () => undefined), "https://b.test": fake("b", () => { throw rateLimited; }), "https://c.test": fake("c", () => "0x01") };
  const rpc = failoverRpc(Object.keys(makers), (u) => makers[u]);
  assert.equal(await rpc("eth_call"), "0x01");
  assert.deepEqual(calls, ["a", "b", "c"]);
  calls.length = 0;
  assert.equal(await rpc("eth_call"), "0x01");
  assert.deepEqual(calls, ["c"]);                                // the provider that answered is asked first
  makers["https://c.test"] = fake("c", () => { throw reverted; });
  const rpc2 = failoverRpc(["https://c.test", "https://a.test"], (u) => makers[u]);
  calls.length = 0;
  await assert.rejects(rpc2("eth_call"), /execution reverted/);
  assert.deepEqual(calls, ["c"]);
});

// FundingSessionVault.topUpWithAuthorization recomputes the TopUp digest from its arguments and passes it to USDC as the
// ReceiveWithAuthorization nonce; the digest here is rebuilt the way the vault builds it (DOMAIN_TYPEHASH, NAME_HASH,
// VERSION_HASH, TOPUP_TYPEHASH, 0x1901), not with the typed-data helper under test.
const USDC_DOMAIN = Object.freeze({ name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
const k = (s) => keccak256(toHex(s));
function vaultTopUpDigest(vault, sid, amount, opNonce, signBefore) {
  const domain = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [k("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), k("Enclave Sessions"), k("2"), 8453n, vault]));
  const struct = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint64" }],
    [k("TopUp(bytes32 sessionId,uint256 amount,bytes32 opNonce,uint64 signBefore)"), sid, amount, opNonce, signBefore]));
  return keccak256(concat(["0x1901", domain, struct]));
}

test("buildRefillTopUp: the USDC authorization's nonce is the vault's TopUp digest; the relay body is exactly its shape", async () => {
  const c = cfg();
  const t = buildRefillTopUp(c, { usdcDomain: USDC_DOMAIN, sessionId: H(0x5e55), amount6: "10000000", opNonce: H(0x77), signBefore: 1_794_400_900n });
  assert.equal(t.digest, vaultTopUpDigest(c.vault, H(0x5e55), 10_000_000n, H(0x77), 1_794_400_900n));
  const a = t.authorization;
  assert.equal(a.primaryType, "ReceiveWithAuthorization");
  assert.deepEqual(a.domain, USDC_DOMAIN);
  assert.deepEqual(a.message, { from: c.owner, to: c.vault, value: 10_000_000n, validAfter: 0n, validBefore: 1_794_400_900n, nonce: t.digest });
  // the relay's ownerArgs("topUpWithAuthorization"): exactly these args, no top-level sig
  const b = t.body("0xsig");
  assert.deepEqual(Object.keys(b).sort(), ["args", "op", "owner", "vault"]);
  assert.deepEqual(b, { owner: c.owner, vault: c.vault, op: "topUpWithAuthorization",
    args: { sessionId: H(0x5e55), amount: "10000000", opNonce: H(0x77), validAfter: "0", validBefore: "1794400900", sig: "0xsig" } });
  // a wallet signature over the authorization recovers to its signer (what the page's /signed check relies on)
  const owner = privateKeyToAccount(H(0x0b2d));
  const o = cfg(owner.address);
  const t2 = buildRefillTopUp(o, { usdcDomain: USDC_DOMAIN, sessionId: H(0x5e55), amount6: 1n, opNonce: H(0x77), signBefore: 1_794_400_900n });
  const sig = await owner.signTypedData(t2.authorization);
  assert.equal(await recoverTypedDataAddress({ ...t2.authorization, signature: sig }), owner.address);
  assert.notEqual(t2.digest, t.digest);                            // the amount is part of the digest, so of the nonce
});

test("buildRefillTopUp: refuses a zero or over-ceiling amount and a missing session or nonce", () => {
  const c = cfg(), base = { usdcDomain: USDC_DOMAIN, sessionId: H(1), amount6: 1n, opNonce: H(2), signBefore: 1_794_400_900n };
  assert.throws(() => buildRefillTopUp(c, { ...base, amount6: 0n }), /top-up must be/);
  assert.throws(() => buildRefillTopUp(c, { ...base, amount6: REFILL_LIMITS.budget6 + 1n }), /top-up must be/);
  assert.equal(buildRefillTopUp(c, { ...base, amount6: REFILL_LIMITS.budget6 }).authorization.message.value, REFILL_LIMITS.budget6);
  assert.throws(() => buildRefillTopUp(c, { ...base, sessionId: H(0) }));
  assert.throws(() => buildRefillTopUp(c, { ...base, opNonce: H(0) }));
});

test("usdc6: decimal USDC to 6dp units, nothing looser", () => {
  assert.equal(usdc6("10"), 10_000_000n);
  assert.equal(usdc6("2.5"), 2_500_000n);
  assert.equal(usdc6(" 0.000001 "), 1n);
  for (const bad of ["", "-1", "1e3", "1.0000001", "0x10", "1,5", true, undefined]) assert.throws(() => usdc6(bad), /--amount must be/);
});
