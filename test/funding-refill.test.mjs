// Automatic lease-gas refill (sdk/funding-node/refill.mjs, sdk/funding-node/node-store.mjs): the refill decision, the grant terms
// it may offer the owner, the Node store a daemon keeps its session key and journal in, and one pass's orchestration
// (reconcile first, never pay while anything is unresolved, at most one refill, lowest runway first).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { fundingConfig, predictVault } from "../sdk/funding/funding-codec.mjs";
import { gasRecordId, newGasRecord, signerFor } from "../sdk/funding/v2-store.mjs";
import { FileV2Store } from "../sdk/funding-node/node-store.mjs";
import { buildRefillGrant, refillNeed, refillOnce, refillTerms, REFILL_LIMITS } from "../sdk/funding-node/refill.mjs";
import { EXEC_SCHEMA } from "../sdk/funding/gas-execution.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "refill-"));
const A = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const H = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const RENEW = 1_386_930_418_318n, CLAIM = 2_288_400_237_629n;      // live quotes at 0.006 gwei, 2026-11-11

function cfg() {
  const factory = A(0xf1), implementation = A(0xf2), owner = A(0x0b2d);
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
