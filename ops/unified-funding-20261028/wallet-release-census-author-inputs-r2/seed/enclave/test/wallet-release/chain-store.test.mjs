// AUTHORED, NOT RUN. Pure checks of the chain gate helpers and the journal rules. MemoryJournal is a MOCK (not
// IndexedDB); IdbJournal is exercised only by root's browser test (held-card.fixture.html).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkReleaseTypedData, releaseCalldata, decodeReleaseCalldata, promotedHash, evaluate, PINS, RELEASE_SELECTOR,
  ROOT_QUALIFIED_CONTINUITY } from "../../site/js/core/wallet-release-chain.js";
import { MemoryJournal, journalKey, validateRecord, JOURNAL_SCHEMA } from "../../site/js/core/wallet-release-store.js";
import { keccak256Utf8, keccak256Hex } from "../../site/js/core/keccak.js";

const W = "0x0b2d009c0c9af05b12100d77f3c815fea822ee61", V = "0xb794c4dd0e1c5e6b72281799f282bfde7654345d";
const ID = "0xcab8fb59882d976bf4005448701149d734b0dab536d9bf46f2b5159b0b0819e9";
const now = 1793317131;
const td = (patch = {}) => ({ primaryType: "Release",
  domain: { name: "Enclave Sessions", version: "1", chainId: 8453, verifyingContract: V, ...(patch.domain || {}) },
  types: { Release: [{ name: "deployment", type: "bytes32" }, { name: "to", type: "address" }, { name: "opNonce", type: "bytes32" }, { name: "signBefore", type: "uint64" }], ...(patch.types || {}) },
  message: { deployment: ID, to: W, opNonce: "0x" + "ab".repeat(32), signBefore: BigInt(now + 600), ...(patch.message || {}) }, ...(patch.top || {}) });
const ctx = { chainId: 8453, vault: V, id: ID, wallet: W };

test("typed data guard accepts exactly the SDK Release and nothing else", () => {
  assert.equal(checkReleaseTypedData(td(), ctx, now).nonce, "0x" + "ab".repeat(32));
  const bad = [
    { top: { primaryType: "Promote" } }, { domain: { chainId: 1 } }, { domain: { verifyingContract: W } }, { domain: { name: "x" } },
    { domain: { salt: "0x" + "00".repeat(32) } }, { types: { Extra: [] } }, { message: { to: "0x" + "77".repeat(20) } },
    { message: { deployment: "0x" + "12".repeat(32) } }, { message: { extra: 1 } }, { message: { opNonce: "0x" + "00".repeat(32) } },
    { message: { signBefore: BigInt(now - 1) } }, { message: { signBefore: BigInt(now + 7200) } },
  ];
  for (const b of bad) assert.throws(() => checkReleaseTypedData(td(b), ctx, now), /Refused to sign/, JSON.stringify(b, (_k, v) => typeof v === "bigint" ? String(v) : v));
});

test("release calldata: exact selector, canonical round trip only", () => {
  assert.equal(RELEASE_SELECTOR, keccak256Utf8("release(bytes32,address,bytes32,uint64,bytes)").slice(0, 10));
  const sig = "0x" + "11".repeat(64) + "1b";
  const data = releaseCalldata(ID, W, "0x" + "ab".repeat(32), 1793317731n, sig);
  const d = decodeReleaseCalldata(data);
  assert.deepEqual([d.id, d.to, d.opNonce, d.signBefore, d.sig], [ID, W, "0x" + "ab".repeat(32), 1793317731n, sig]);
  assert.equal(decodeReleaseCalldata(data + "00"), null);
  assert.equal(decodeReleaseCalldata("0x12345678" + data.slice(10)), null);
});

test("promoted commitment is keccak256(abi.encode(string,string))", () => {
  const w = (n) => n.toString(16).padStart(64, "0");
  // abi.encode("", "") = offset 0x40, offset 0x60, len 0, len 0
  assert.equal(promotedHash("", ""), keccak256Hex("0x" + w(64) + w(96) + w(0) + w(0)));
  // abi.encode("ab", "c") = 0x40, 0x80, len 2, "ab" right-padded, len 1, "c" right-padded
  assert.equal(promotedHash("ab", "c"), keccak256Hex("0x" + w(64) + w(128) + w(2) + "6162".padEnd(64, "0") + w(1) + "63".padEnd(64, "0")));
  assert.notEqual(promotedHash("a", ""), promotedHash("", "a"));
});

// historical inventory rows, read-only: explanatory fixtures, not present-state evidence
const inv = JSON.parse(readFileSync(new URL("../../../../readonly-reference/inventory-public.json", import.meta.url), "utf8"));
const snapOf = (a, held = [2, null]) => {
  const d = a.deployment;
  const row = { ...d, id: d.id.toLowerCase(), owner: d.owner.toLowerCase(), runner: d.runner.toLowerCase(), runnerOperator: d.runnerOperator.toLowerCase(),
    gpuMilli: String(d.gpuMilli), cpuMilli: String(d.cpuMilli), appPort: String(d.appPort) };
  const r = (x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === "boolean" ? v : typeof v === "number" ? String(v) : String(v).toLowerCase()]));
  return { block: { number: "1", hash: "0x" + "aa".repeat(32), timestamp: String(now) },
    identity: { chainId: 8453, ledger: PINS.ledger, vault: V, wallet: W, deployment: row.id, owner: W },
    pre: { row, ownerEscrow6: a.ownerEscrow6, earn: { rate6: a.earn[0], escrow6: a.earn[1], creditedUntil: a.earn[2] }, cap: a.cap,
      fee: { recipient: a.fee[0].toLowerCase(), rate6: a.fee[1] }, oldReserve: r(a.oldReserve), newReserve: r(a.newReserve) },
    held: { env: held[0], promoted: held[1] || promotedHash(row.appRef, row.configCid), createdBy: "0x" + "0".repeat(64) }, delegationGranted: true };
};
const codes = (e) => e.blockers.map((b) => b.code);

test("historical KVM 9a28642b and DNS 59f1273d stay blocked (active, lease, escrow, old reserve)", () => {
  for (const pre of ["0x9a28642b", "0x59f1273d"]){
    const a = inv.vaultApps.find((x) => x.deployment.id.startsWith(pre));
    const c = codes(evaluate(snapOf(a), { nowSec: now }));
    for (const k of ["active", "lease", "escrow", "old-reserve", "continuity"]) assert.ok(c.includes(k), pre + " " + k);
  }
});

test("cab8fb59: positive runtime balance alone is not a blocker; staging and continuity still are", () => {
  const a = inv.vaultApps.find((x) => x.deployment.id.startsWith("0xcab8fb59"));
  const c = codes(evaluate(snapOf(a, [1, "0x" + "0".repeat(64)]), { nowSec: now }));
  assert.deepEqual(c.sort(), ["continuity", "staging"]);
  assert.equal(ROOT_QUALIFIED_CONTINUITY.length, 0, "no row is qualified in source");
});

test("journal: put-if-absent, CAS, single writer, transitions, bounded shape", async () => {
  const identity = { chainId: 8453, ledger: PINS.ledger, vault: V, wallet: W, deployment: ID, owner: W };
  const key = journalKey(identity);
  const base = { schema: JOURNAL_SCHEMA, key, identity, state: "intent", rev: 0, writer: "a", nonce: "0x" + "ab".repeat(32), deadline: "1", typed: {}, prestate: {} };
  assert.throws(() => validateRecord({ ...base, sig: "0x00" }), /signature never/);
  assert.throws(() => journalKey({ ...identity, vault: "nope" }));
  const j = new MemoryJournal();
  await j.putIfAbsent(base);
  await assert.rejects(j.putIfAbsent({ ...base, writer: "b" }), (e) => e.code === "exists");
  await assert.rejects(j.cas(key, { state: "intent", rev: 0, writer: "b" }, { state: "signed" }), (e) => e.code === "writer");
  await assert.rejects(j.cas(key, { state: "intent", rev: 0, writer: "a" }, { state: "submitted" }), (e) => e.code === "transition");
  const s = await j.cas(key, { state: "intent", rev: 0, writer: "a" }, { state: "signed", nonce: "0x" + "cc".repeat(32) });
  assert.equal(s.nonce, base.nonce, "identity fields are immutable");
  await assert.rejects(j.cas(key, { state: "intent", rev: 0, writer: "a" }, { state: "cancelled" }), (e) => e.code === "cas");
  const d = await j.cas(key, { state: "signed", rev: 1, writer: "a" }, { state: "dispatching" });
  await assert.rejects(j.cas(key, { state: "dispatching", rev: 2 }, { state: "cancelled" }), (e) => e.code === "transition");
  await assert.rejects(j.putIfAbsent({ ...base, writer: "c" }, { replaceRev: d.rev }), (e) => e.code === "exists");
});
