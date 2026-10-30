// node --test enclave/test/wallet-release/   (root sets WALLET_CENSUS_LEDGER_CREATOR, see report)
// Explicit owner-elected PROD path: real chain gate, census, release + promotion controllers, MemoryJournal (NOT
// IndexedDB), fake RPC/provider/relay. The "EXACT shipped SDK" tests import ../shipped-sessions.mjs unconditionally.
// Proves nothing about live Base, browser IndexedDB, installed hosts or the relay.
import test from "node:test";
import assert from "node:assert/strict";
import { createReleaseController, ReleaseError } from "../../site/js/core/wallet-release-controller.js";
import { createPromotionController, checkPromoteTypedData, promoteCalldata, decodePromoteCalldata, TOPIC_PROMOTED, PROMOTE_TYPE } from "../../site/js/core/wallet-release-promote.js";
import { MemoryJournal, journalKey, promoteKey, fenceConflict, JOURNAL_SCHEMA } from "../../site/js/core/wallet-release-store.js";
import { PINS, promotedHash, bookKey, issueOwnerReview, RELEASE_TYPE } from "../../site/js/core/wallet-release-chain.js";
import { censusWorld, session, W, V } from "./census-world.fixture.mjs";

const ID = "0xcab8fb59882d976bf4005448701149d734b0dab536d9bf46f2b5159b0b0819e9", ID2 = "0x" + "02".repeat(32);
const Z32 = "0x" + "0".repeat(64), Z20 = "0x" + "0".repeat(40), SIG = "0x" + "11".repeat(64) + "1b";
const CAT = PINS.catalog, PUB = "0x" + "9b".repeat(20), APPID = "0x" + "ab".repeat(32), OTHER = "0x" + "6f".repeat(20);
const REF = "catalog://" + APPID + "/3", CFG = "bafycfg";
const COMMIT = promotedHash(REF, CFG);
const zr = () => ({ balanceWei: 0n, maxPerOpWei: 0n, epochCapWei: 0n, enabled: false, claimPolicy: 0, sponsorRelease: false, renewWindow: 0, minExtension: 0,
  claimCooldown: 0, epochSec: 0, maxGasPrice: 0n, maxClaimsPerEpoch: 0, epochIndex: 0, epochSpentWei: 0n, epochClaims: 0, lastClaimAt: 0n, lastClaimOperator: Z20 });
const w = (n) => BigInt(n).toString(16).padStart(64, "0");
const hx = (s) => Array.from(new TextEncoder().encode(s), (x) => x.toString(16).padStart(2, "0")).join("");
const tl = (h) => w(h.length / 2) + (h.length ? h.padEnd(Math.ceil(h.length / 64) * 64, "0") : "");
const TYPES = { Promote: PROMOTE_TYPE, Release: RELEASE_TYPE };
const OPS = { promote: "Promote", release: "Release" };

/** cab8-like: inactive, unleased, 9.5 USDC runtime, zero escrow/reserves, unpromoted PRODUCTION. */
function setup({ over = {}, cw = {}, journal = new MemoryJournal(), onSign, relayMode = "ok", nonce, sdk: realSdk, mutate } = {}){
  const st = { chainId: 8453, now: Math.floor(Date.now() / 1000), block: 53263892n, hash: "0x" + "aa".repeat(32), canon: new Map(), txs: new Map(), used: new Set(), finalized: 0n,
    row: { id: ID, owner: V, appRef: REF, ports: "http:8000", configCid: CFG, gpuMilli: 0, cpuMilli: 40, appPort: 8000, isPublic: true, active: false,
      createdAt: 1n, rate: 1n, balance6: 9500000n, spent6: 0n, runner: Z32, runnerOperator: Z20, leaseUntil: 0n },
    held: [2, Z32, Z32], ownerEscrow6: 0n, earn: [0n, 0n, 0n], label: "1.0.79", slug: "cab8", publisher: PUB, catalogCode: PINS.catalogCodeHash, ...over };
  const world = censusWorld(st, cw);
  const bh = (n) => st.canon.get(BigInt(n)) || st.hash;
  const reader = {
    chainId: async () => st.chainId,
    latestBlock: async () => ({ number: st.block, hash: bh(st.block), timestamp: BigInt(st.now) }),
    blockByNumber: async (n) => n === "finalized" ? (st.finalized ? { number: st.finalized, hash: bh(st.finalized), timestamp: BigInt(st.now) } : null) : { number: BigInt(n), hash: bh(n), timestamp: BigInt(st.now) },
    codeHash: async (a) => ({ [PINS.factory]: PINS.factoryCodeHash, [V]: PINS.vaultCodeHash, [PINS.ledger]: PINS.ledgerCodeHash, [PINS.reserve]: PINS.reserveCodeHash, [CAT]: st.catalogCode })[a.toLowerCase()],
    storageAt: async (a, slot, b) => world.slotValue(slot, b),
    simulate: async () => ({ data: "0x" }),
    read: async (address, _abi, fn, args) => {
      if (fn === "addr") return args[0] === bookKey("appCatalog") ? CAT : PINS.ledger;
      if (fn === "getApp") return { appId: APPID, publisher: st.publisher, slug: st.slug, name: "Cab", description: "", versionCount: 4, createdAt: 1n, updatedAt: 1n, active: true };
      if (fn === "getVersion") return { cid: "bafyimg", version: st.label, vramMb: 0, gpuGflops: 0, memMb: 0, cpuGflops: 0, createdAt: 1n, verified: true, yanked: false, ports: "", approval: 0, config: "" };
      if (fn === "ownerNonceUsed") return st.used.has(String(args[0]).toLowerCase());
      return ({ factory: PINS.factory, owner: W, book: PINS.book, isVault: true, vaultFor: V, deploymentsSchema: 16n, ledger: PINS.ledger, get: { ...st.row },
        ownerEscrow6: st.ownerEscrow6, earnOf: st.earn, capOf: 1n, feeOf: [Z20, 0n], held: st.held, reserveOf: zr() })[fn]; },
    receipt: async (h) => (st.txs.get(h) || {}).rc || null, tx: async (h) => (st.txs.get(h) || {}).tx || null,
    logs: async (q) => [...st.txs.values()].flatMap((x) => x.rc.logs.filter((l) => l.address === q.address && l.topics[0] === q.topics[0]).map((l) => ({ ...l, transactionHash: x.tx.hash }))),
  };
  // External RPC fixtures now expose the reviewed catalog on both independent history readers.
  // Keep each reader's census/provenance behavior; only add the missing catalog interface.
  for (const r of world.readers.history){
    const originalRead = r.read.bind(r), originalCode = r.codeHash.bind(r);
    r.read = async (a, abi, fn, args, at) => (fn === "addr" && args[0] === bookKey("appCatalog")) || fn === "getApp" || fn === "getVersion"
      ? reader.read(a, abi, fn, args, at) : originalRead(a, abi, fn, args, at);
    r.codeHash = async (a, at) => a.toLowerCase() === CAT ? reader.codeHash(a, at) : originalCode(a, at);
  }
  reader.blockTxHashes = async (at) => ({ number: BigInt(at), hash: bh(at), transactions: [...st.txs.values()].filter(x => x.tx.blockNumber === BigInt(at)).map(x => x.tx.hash) });
  const provider = { signs: 0, typed: [], async request({ method, params }){ journal.log.push("provider:" + method);
    if (method === "eth_chainId") return "0x2105"; if (method === "eth_accounts") return [W];
    if (method === "eth_signTypedData_v4"){ this.signs++; this.typed.push(typeof params[1] === "string" ? JSON.parse(params[1]) : JSON.parse(JSON.stringify(params[1], (_k, v) => typeof v === "bigint" ? String(v) : v))); if (onSign) await onSign(st, world.cw); return SIG; } throw new Error(method); } };
  const relay = { posts: [], async request(m, p, body){ journal.log.push("relay:" + m); this.posts.push(body); if (relayMode === "timeout") throw new Error("timeout");
    return { txHash: "0x" + (this.posts.length).toString(16).padStart(64, "c") }; } };
  let n = 0;
  // inert stand-in mirroring the shipped XM: { op, ...fields } + opNonce/signBefore, As(chainId, vault, ig[op], s), one POST
  const fake = { ownerFromProvider: (pr, address) => ({ address, signTypedData: (td) => pr.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(td, (_k, v) => typeof v === "bigint" ? String(v) : v)] }) }),
    async ownerOperation(p){ const { op, ...f } = p.op; const s = { ...f, opNonce: nonce || "0x" + w(++n + 0x100), signBefore: BigInt(st.now + 600) };
      const td = { domain: { name: "Enclave Sessions", version: "1", chainId: p.chainId, verifyingContract: p.vault }, types: { [OPS[op]]: TYPES[OPS[op]] }, primaryType: OPS[op], message: s };
      const sig = await p.owner.signTypedData(td); const body = { owner: p.owner.address, vault: p.vault, op, args: s, sig }; if (mutate) mutate(body); return p.relay.request("POST", "/owner", body); } };
  const sdk = realSdk || fake;
  const deps = (d = ID) => ({ sdk, provider, relay, reader, journal, census: world.census, wallet: W, vault: V, deployment: d, nowSec: () => st.now, writer: "0x" + "01".repeat(32) });
  const h = { st, ...world, reader, journal, provider, relay, deps };
  h.c = createReleaseController(deps()); h.p = createPromotionController(deps());
  /** The relay's promotion lands: exact calldata, receipt, Promoted event, held commitment, nonce used. */
  h.land = ({ status = "success", nonceOverride, logData } = {}) => {
    const body = relay.posts.find((b) => b.op === "promote"), a = { ...body.args, signBefore: String(body.args.signBefore) };
    const hash = "0x" + (relay.posts.indexOf(body) + 1).toString(16).padStart(64, "c"), at = st.block + 1n;
    const input = promoteCalldata({ ...a, opNonce: nonceOverride || a.opNonce }, body.sig);
    const ta = tl(hx(a.appRef)), data = logData || "0x" + COMMIT.slice(2) + w(96) + w(96 + ta.length / 2) + ta + tl(hx(a.configCid));
    st.txs.set(hash, { tx: { hash, to: V, input, blockNumber: at, blockHash: bh(at) }, rc: { transactionHash: hash, status, blockNumber: at, blockHash: bh(at), logs: [{ address: V, topics: [TOPIC_PROMOTED, ID], data }] } });
    st.block = at; st.held = [2, COMMIT, Z32]; st.used.add(a.opNonce.toLowerCase()); st.finalized = at;
    return hash;
  };
  return h;
}
const codes = (s) => s.blockers.map((b) => b.code);

test("default PROD refusal is unchanged: unpromoted, drifted and promoted PROD stay blocked without an owner review", async () => {
  for (const [held, code] of [[[2, Z32, Z32], "unpromoted"], [[2, "0x" + "12".repeat(32), Z32], "content-drift"], [[2, COMMIT, Z32], "prod-custody"]]){
    const h = setup({ over: { held } });
    assert.ok(codes(await h.c.check()).includes(code));
    await assert.rejects(h.c.release(), ReleaseError);
    await assert.rejects(h.c.release({ step: "release", reviewHash: (await h.c.check()).review.ownerReviewHash }), ReleaseError);   // a look-alike, not an issued review
    assert.equal(h.provider.signs, 0); assert.equal(h.relay.posts.length, 0);
  }
});

test("explicit two steps: same-content Promote, confirmed on-chain, then a separately reviewed fresh Release", async () => {
  const h = setup();
  const ps = await h.p.check();
  assert.equal(ps.kind, "eligible", JSON.stringify(ps.blockers));
  assert.deepEqual(ps.review.content, { deployment: ID, app: "cab8", publisher: PUB, appRef: REF, configCid: CFG, versionLabel: "1.0.79", isPublic: true });
  assert.equal(ps.review.commitment, COMMIT); assert.equal(ps.review.balance6, "9500000"); assert.equal(ps.review.destination, W);
  await assert.rejects(h.p.promote(), (e) => e.code === "review");                       // never without the owner's click
  await h.p.promote(issueOwnerReview(ps.review, "promote"));
  assert.equal(h.provider.signs, 1); assert.equal(h.relay.posts.length, 1);
  assert.equal(h.relay.posts[0].op, "promote");                                             // never chained into a release
  const rec = await h.journal.get(h.p.key);
  assert.equal(rec.kind, "promote"); assert.equal(rec.state, "submitted"); assert.ok(!("sig" in rec)); assert.match(rec.sigHash, /^0x[0-9a-f]{64}$/);
  const e = h.journal.log;
  assert.ok(e.indexOf("put:promote:intent") < e.indexOf("provider:eth_signTypedData_v4") && e.indexOf("cas:dispatching") < e.indexOf("relay:POST"));
  // submitted is not confirmation: release is fenced, and the stale promote-step review is not a release election
  assert.ok(codes(await h.c.check()).includes("promotion-pending"));
  await assert.rejects(h.c.release(issueOwnerReview(ps.review, "promote")), ReleaseError);
  h.land();
  assert.equal((await h.p.recover()).record.state, "finalized");
  const rs = await h.c.check();
  assert.deepEqual(codes(rs), ["prod-custody"]);
  assert.equal(rs.review.commitment, COMMIT); assert.ok(rs.review.ownerReviewHash !== ps.review.ownerReviewHash);   // fresh review required
  await assert.rejects(h.c.release(issueOwnerReview(ps.review, "release")), ReleaseError);   // old review: state changed since
  assert.equal(h.relay.posts.length, 1);
  await h.c.release(issueOwnerReview(rs.review, "release"));
  assert.equal(h.provider.signs, 2); assert.equal(h.relay.posts.length, 2); assert.equal(h.relay.posts[1].op, "release");
  const r = await h.journal.get(h.c.key);
  assert.equal(r.state, "submitted"); assert.equal(r.ownerReview, rs.review.ownerReviewHash); assert.equal(r.commitment, COMMIT);
});

test("already promoted: explicit election goes straight to Release; promotion is not offered or redone", async () => {
  const h = setup({ over: { held: [2, COMMIT, Z32] } });
  assert.ok(codes(await h.p.check()).includes("already-promoted"));
  const s = await h.c.check();
  assert.deepEqual(codes(s), ["prod-custody"]);
  await h.c.release(issueOwnerReview(s.review, "release"));
  assert.equal(h.relay.posts.length, 1); assert.equal(h.relay.posts[0].op, "release");
});

test("STAGING path unchanged; promotion never offered for STAGING", async () => {
  const h = setup({ over: { held: [1, Z32, Z32], row: undefined } });
  h.st.row = { ...h.st.row || {}, id: ID, owner: V, appRef: "catalog://x/0", ports: "", configCid: "", gpuMilli: 0, cpuMilli: 0, appPort: 0, isPublic: true, active: false,
    createdAt: 1n, rate: 1n, balance6: 9500000n, spent6: 0n, runner: Z32, runnerOperator: Z20, leaseUntil: 0n };
  const s = await h.c.check();
  assert.equal(s.kind, "eligible", JSON.stringify(s.blockers)); assert.equal(s.review.ownerReviewHash, null);
  assert.ok(codes(await h.p.check()).includes("not-prod"));
  await h.c.release();
  assert.equal(h.relay.posts.length, 1);
});

test("census source env: prod-only grant on source-PROD is not a new privilege; on STAGING it still blocks; other/unknown authority blocks", async () => {
  const prodOnly = { vaults: { [V]: { owner: W, epoch: 1n, sessions: [session("p", { envs: 2 })] } } };
  const h = setup({ over: { held: [2, COMMIT, Z32] }, cw: prodOnly });
  const s = await h.c.check();
  assert.deepEqual(codes(s), ["prod-custody"]); assert.match(s.review.census.preserved.join(" "), /production only.*already reaches/);
  const g = setup({ over: { held: [1, Z32, Z32] }, cw: prodOnly });
  g.st.row.appRef = "catalog://x/0";
  assert.ok(codes(await g.c.check()).includes("prod-only-gain"));
  const u = setup({ over: { held: [2, COMMIT, Z32] }, cw: { delegations: [{ owner: W, delegate: V, allowed: true, block: 52600000n }, { owner: W, delegate: OTHER, allowed: true, block: 52610000n }] } });
  const us = await u.c.check();
  assert.ok(codes(us).includes("unknown-delegate"));
  await assert.rejects(u.c.release(issueOwnerReview(us.review, "release")), ReleaseError);
  assert.ok(codes(await setup({ cw: { delegations: [{ owner: W, delegate: V, allowed: true, block: 52600000n }, { owner: V, delegate: OTHER, allowed: true, block: 52610000n }] } }).p.check()).includes("source-delegate"));
  assert.equal(u.relay.posts.length, 0);
});

test("inactive/unleased/escrow/reserve gates still refuse both steps", async () => {
  for (const over of [{ row: null, active: true }, { lease: true }, { ownerEscrow6: 1n, earn: [0n, 1n, 0n] }]){
    const h = setup({ over: { held: [2, COMMIT, Z32], ...(over.ownerEscrow6 ? { ownerEscrow6: over.ownerEscrow6, earn: over.earn } : {}) } });
    if (over.active) h.st.row.active = true;
    if (over.lease) h.st.row.leaseUntil = 5n;
    const s = await h.c.check();
    await assert.rejects(h.c.release(issueOwnerReview(s.review, "release")), ReleaseError);
    const u = setup({ over: over.ownerEscrow6 ? { ownerEscrow6: over.ownerEscrow6, earn: over.earn } : {} });
    if (over.active) u.st.row.active = true;
    if (over.lease) u.st.row.leaseUntil = 5n;
    assert.notEqual((await u.p.check()).kind, "eligible");
    assert.equal(h.relay.posts.length + u.relay.posts.length, 0);
  }
});

test("review drift: content, catalog label/publisher, public flag, promotion, balance, session or delegate changes need a fresh review", async () => {
  const changes = [(st) => { st.row.configCid = "bafyother"; }, (st) => { st.label = "1.0.80"; }, (st) => { st.publisher = OTHER; }, (st) => { st.row.isPublic = false; },
    (st) => { st.held = [2, "0x" + "12".repeat(32), Z32]; }, (st) => { st.row.balance6 = 9600000n; },
    (st, cw) => { cw.vaults[V].sessions.push(session("late", { envs: 3, block: st.block + 1n })); st.block += 1n; },     // in the tail after the reviewed anchor
    (st, cw) => { cw.delegations.push({ owner: W, delegate: OTHER, allowed: true, block: st.block + 1n }); st.block += 1n; }];
  for (const ch of changes){
    const r = setup({ over: { held: [2, COMMIT, Z32] } });
    const s = await r.c.check();
    ch(r.st, r.cw);
    await assert.rejects(r.c.release(issueOwnerReview(s.review, "release")), ReleaseError);
    const p = setup();
    const ps = await p.p.check();
    ch(p.st, p.cw);
    await assert.rejects(p.p.promote(issueOwnerReview(ps.review, "promote")), ReleaseError);
    assert.equal(r.provider.signs + p.provider.signs, 0); assert.equal(r.relay.posts.length + p.relay.posts.length, 0);
  }
  // drift during the wallet prompt: durable cancel, nothing sent
  const d = setup({ onSign: async (st) => { st.label = "1.0.80"; } });
  await assert.rejects(d.p.promote(issueOwnerReview((await d.p.check()).review, "promote")), (e) => e.code === "revalidate");
  assert.equal(d.relay.posts.length, 0); assert.equal((await d.journal.get(d.p.key)).state, "cancelled");
});

test("Promote typed data and POST exactness", async () => {
  const expect = { deployment: ID, app: "cab8", publisher: PUB, appRef: REF, configCid: CFG, versionLabel: "1.0.79", isPublic: true };
  const now = Math.floor(Date.now() / 1000);
  const td = { domain: { name: "Enclave Sessions", version: "1", chainId: 8453, verifyingContract: V }, types: { Promote: PROMOTE_TYPE }, primaryType: "Promote",
    message: { ...expect, opNonce: "0x" + "ab".repeat(32), signBefore: BigInt(now + 600) } };
  assert.equal(checkPromoteTypedData(td, { chainId: 8453, vault: V, expect }, now).nonce, "0x" + "ab".repeat(32));
  for (const bad of [{ message: { ...td.message, appRef: "catalog://" + APPID + "/4" } }, { message: { ...td.message, isPublic: "true" } }, { message: { ...td.message, extra: 1 } },
    { domain: { ...td.domain, verifyingContract: OTHER } }, { primaryType: "Release" }, { message: { ...td.message, versionLabel: "1.0.80" } }])
    assert.throws(() => checkPromoteTypedData({ ...td, ...bad }, { chainId: 8453, vault: V, expect }, now));
  const m = { ...td.message, signBefore: String(td.message.signBefore) };
  assert.deepEqual(decodePromoteCalldata(promoteCalldata(m, SIG)), { ...m, sig: SIG });
  assert.equal(decodePromoteCalldata(promoteCalldata(m, SIG) + "00"), null);
  const h = setup({ mutate: (b) => { b.args.configCid = "bafyother"; } });
  await assert.rejects(h.p.promote(issueOwnerReview((await h.p.check()).review, "promote")), (e) => e.code === "relay-shape");
  assert.equal(h.relay.posts.length, 0); assert.equal((await h.journal.get(h.p.key)).state, "cancelled");
});

test("invalidation during the dispatch CAS, and two tabs: no POST / one signature", async () => {
  const h = setup();
  const cas = h.journal.cas.bind(h.journal);
  h.journal.cas = async (...a) => { const r = await cas(...a); if (a[2].state === "dispatching") h.p.dispose(); return r; };
  await h.p.promote(issueOwnerReview((await h.p.check()).review, "promote")).catch(() => {});
  assert.equal(h.provider.signs, 1); assert.equal(h.relay.posts.length, 0);
  const t = setup();
  const t2 = createPromotionController({ ...t.deps(), writer: "0x" + "02".repeat(32) });
  const rv = (await t.p.check()).review;
  const out = await Promise.allSettled([t.p.promote(issueOwnerReview(rv, "promote")), t2.promote(issueOwnerReview(rv, "promote"))]);
  assert.equal(out.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(t.provider.signs, 1); assert.equal(t.relay.posts.length, 1);
});

test("uncertain/reload/reorg/foreign/failed promotion: no resend, no early Release", async () => {
  const h = setup({ relayMode: "timeout" });
  const rv = (await h.p.check()).review;
  await assert.rejects(h.p.promote(issueOwnerReview(rv, "promote")), (e) => e.code === "uncertain");
  await assert.rejects(h.p.promote(issueOwnerReview(rv, "promote")), (e) => e.code === "exists");
  const reload = createPromotionController(h.deps());                                 // a new page: no consent carried over
  assert.equal((await reload.recover()).outcome.status, "unresolved");
  assert.equal((await reload.check()).kind, "journal");
  assert.ok(codes(await createReleaseController(h.deps()).check()).includes("promotion-pending"));
  assert.equal(h.provider.signs, 1); assert.equal(h.relay.posts.length, 1);
  // foreign nonce in the only Promoted tx: not this operation; arbitrary later promotion is not proof
  h.land({ nonceOverride: "0x" + "ee".repeat(32) }); h.st.used.delete(h.relay.posts[0].args.opNonce.toLowerCase());
  assert.equal((await reload.recover()).outcome.status, "unresolved");
  // the exact one, but reorged out, then failed receipt / wrong event
  for (const [o, want] of [[{ reorg: true }, "submitted"], [{ status: "reverted" }, "conflict"]]){
    const g = setup({ relayMode: "ok" });
    await g.p.promote(issueOwnerReview((await g.p.check()).review, "promote"));
    const hash = g.land(o.status ? { status: o.status } : {});
    if (o.reorg) g.st.canon.set(g.st.block, "0x" + "e1".repeat(32)), g.st.txs.get(hash).rc.blockHash = "0x" + "e2".repeat(32);
    assert.equal((await g.p.recover()).record.state, want);
    assert.ok(codes(await g.c.check()).includes("promotion-pending"));
    assert.equal(g.relay.posts.length, 1);
  }
  const ev = setup();
  await ev.p.promote(issueOwnerReview((await ev.p.check()).review, "promote"));
  ev.land({ logData: "0x" + "12".repeat(32) });
  assert.equal((await ev.p.recover()).record.state, "conflict");
});

test("shared owner nonce fence, both directions, other deployment, two tabs, old schema1 Release records", async () => {
  const journal = new MemoryJournal();
  const ident = (d) => ({ chainId: 8453, ledger: PINS.ledger, vault: V, wallet: W, deployment: d, owner: W });
  const N = "0x" + "77".repeat(32);
  // an unresolved schema-1 Release (no `kind`, exactly the seed shape) of ANOTHER deployment fences Promote
  await journal.putIfAbsent({ schema: JOURNAL_SCHEMA, key: journalKey(ident(ID2)), identity: ident(ID2), state: "uncertain", rev: 0, writer: "x", nonce: N, deadline: "1" });
  const h = setup({ journal });
  assert.ok(codes(await h.p.check()).includes("release-pending"));
  await assert.rejects(h.p.promote(issueOwnerReview((await h.p.check()).review, "promote")), (e) => e.code === "fence");
  assert.equal(h.provider.signs, 0);
  assert.equal((await journal.get(journalKey(ident(ID2)))).state, "uncertain");          // retained, not relabelled
  // same nonce across kinds is refused even when the other record is resolved
  const pr = { schema: JOURNAL_SCHEMA, kind: "promote", key: promoteKey(ident(ID)), identity: ident(ID), state: "intent", rev: 0, writer: "x", nonce: N, deadline: "1" };
  assert.match(fenceConflict([{ ...(await journal.get(journalKey(ident(ID2)))), state: "finalized" }], pr), /nonce/);
  // reverse: an unresolved Promote fences a Release of another deployment (STAGING), from another tab/reload
  const j2 = new MemoryJournal();
  await j2.putIfAbsent({ ...pr, nonce: "0x" + "78".repeat(32) });
  const r = setup({ journal: j2, over: { held: [1, Z32, Z32] } });
  r.st.row.appRef = "catalog://x/0";
  const rc = createReleaseController({ ...r.deps(ID2) });
  assert.ok(codes(await rc.check()).includes("promotion-pending"));
  await assert.rejects(rc.release(), (e) => e.code === "fence");
  await assert.rejects(j2.putIfAbsent({ schema: JOURNAL_SCHEMA, key: journalKey(ident(ID2)), identity: ident(ID2), state: "intent", rev: 0, writer: "y", nonce: "0x" + "79".repeat(32), deadline: "1" }), (e) => e.code === "fence");
  assert.equal(r.provider.signs, 0); assert.equal(r.relay.posts.length, 0);
});

test("EXACT shipped SDK: ownerOperation promote then (separately) release through the guarded seams", async () => {
  const SDK = await import("../fixtures/wallet-release/shipped-sessions.mjs");
  assert.equal(typeof SDK.ownerOperation, "function"); assert.equal(typeof SDK.ownerFromProvider, "function");
  const h = setup({ sdk: { ownerOperation: SDK.ownerOperation, ownerFromProvider: SDK.ownerFromProvider } });
  await h.p.promote(issueOwnerReview((await h.p.check()).review, "promote"));
  assert.equal(h.provider.signs, 1); assert.equal(h.relay.posts.length, 1);
  const t = h.provider.typed[0];
  assert.equal(t.primaryType, "Promote"); assert.deepEqual(t.types.Promote, PROMOTE_TYPE);
  const b = h.relay.posts[0];
  assert.deepEqual(Object.keys(b).sort(), ["args", "op", "owner", "sig", "vault"]); assert.equal(b.op, "promote"); assert.equal(b.args.appRef, REF); assert.equal(b.args.isPublic, true);
  h.land();
  assert.equal((await h.p.recover()).record.state, "finalized");
  const s = await h.c.check();
  await h.c.release(issueOwnerReview(s.review, "release"));
  assert.equal(h.relay.posts.length, 2); assert.equal(h.relay.posts[1].op, "release"); assert.equal(h.provider.typed[1].primaryType, "Release");
  assert.notEqual(h.relay.posts[0].args.opNonce, h.relay.posts[1].args.opNonce);
});


// ROOT adversarial boundaries. Actual modules with inert readers/signers; no chain transaction.
for (const oldKind of [undefined, "promote"]) test("ROOT old-ledger unresolved " + (oldKind || "release") + " fences the same vault owner", async () => {
 const journal = new MemoryJournal();
 const identity = {chainId:8453,ledger:"0x"+"ad".repeat(20),vault:V,wallet:W,owner:W,deployment:ID2};
 const old={schema:1,identity,key:oldKind?promoteKey(identity):journalKey(identity),state:"uncertain",rev:0,nonce:"0x"+"ea".repeat(32),deadline:"1",writer:"old"}; if(oldKind)old.kind=oldKind;
 await journal.putIfAbsent(old);
 const h=setup({journal,over:oldKind?{held:[1,Z32,Z32]}:{}});
 if(oldKind) await assert.rejects(h.c.release(), e=>e.code==="fence");
 else await assert.rejects(h.p.promote(issueOwnerReview((await h.p.check()).review,"promote")),e=>e.code==="fence");
 assert.equal(h.provider.signs,0); assert.equal(h.relay.posts.length,0);
});
test("ROOT independent catalog disagreement prevents a promotion signature",async()=>{
 const h=setup(); const r=h.readers.history[1],read=r.read;
 r.read=async(...a)=>a[2]==="getVersion"?{version:"foreign",cid:"foreign"}:read(...a);
 await assert.rejects(h.p.promote(issueOwnerReview((await h.p.check()).review,"promote")));
 assert.equal(h.provider.signs,0);assert.equal(h.relay.posts.length,0);
});
test("ROOT unreviewed catalog runtime refuses owner content approval",async()=>{
 const h=setup({over:{catalogCode:"0x"+"fa".repeat(32)}});
 assert.equal((await h.p.check()).kind,"blocked");assert.equal(h.provider.signs,0);
});
test("ROOT actual viem reader refuses a missing delegation storage word",async()=>{
 const {viemReader}=await import("../../site/js/core/wallet-release-chain.js");
 await assert.rejects(viemReader({getStorageAt:async()=>undefined}).storageAt(PINS.ledger,Z32,1n));
});
async function mined(){
 const h=setup();await h.p.promote(issueOwnerReview((await h.p.check()).review,"promote"));const hash=h.land();
 const x=h.st.txs.get(hash);x.rc.transactionHash=hash;Object.assign(x.tx,{blockNumber:x.rc.blockNumber,blockHash:x.rc.blockHash});
 h.reader.blockTxHashes=async(n)=>({number:BigInt(n),hash:h.st.canon.get(BigInt(n))||h.st.hash,transactions:[hash]});return {h,hash,x};
}
test("ROOT transplanted receipt cannot finalize promotion",async()=>{
 const {h,x}=await mined();x.rc.transactionHash="0x"+"df".repeat(32);
 assert.equal((await h.p.recover()).record.state,"conflict");
});
test("ROOT late reorg during promotion state verification cannot finalize",async()=>{
 const {h,x}=await mined();const read=h.reader.read;
 h.reader.read=async(...a)=>{const value=await read(...a);if(a[2]==="ownerNonceUsed")h.st.canon.set(x.rc.blockNumber,"0x"+"ef".repeat(32));return value;};
 assert.notEqual((await h.p.recover()).record.state,"finalized");
});

test("ROOT state-changing late reorg remains recoverable pending, never terminal conflict",async()=>{
 const {h,x}=await mined();const read=h.reader.read;
 h.reader.read=async(...a)=>{if(a[2]==="ownerNonceUsed"){h.st.canon.set(x.rc.blockNumber,"0x"+"ef".repeat(32));return false;}return read(...a);};
 const r=await h.p.recover();assert.equal(r.record.state,"submitted");assert.equal(r.outcome.status,"pending");
 assert.equal(h.provider.signs,1);assert.equal(h.relay.posts.length,1);
});
