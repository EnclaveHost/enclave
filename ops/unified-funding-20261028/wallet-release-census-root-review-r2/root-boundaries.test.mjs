// AUTHORED, NOT RUN. node --test enclave/test/wallet-release/
// Everything here is MOCKED: the RPC/chain (an in-memory fake reader), the wallet provider, the relay and the journal
// (MemoryJournal - NOT IndexedDB, not durable). It exercises the actual controller, chain gate and journal rules; it
// proves nothing about real browser storage, Base RPC behaviour or the deployed relay. The SDK stand-in below is
// ownerOperation/typedData/ownerFromProvider transcribed from readonly-reference/sdk-client.ts 290-391; the last test
// runs the EXACT vendored bundle when root supplies WALLET_RELEASE_SDK_FIXTURE (see REPORT-WALLET-RELEASE-R1.md).
import test from "node:test";
import assert from "node:assert/strict";
import { createReleaseController, ReleaseError } from "./candidate/enclave/site/js/core/wallet-release-controller.js";
import { MemoryJournal } from "./candidate/enclave/site/js/core/wallet-release-store.js";
import { PINS, promotedHash, releaseCalldata, TOPIC_VAULT_RELEASED, TOPIC_TRANSFERRED } from "./candidate/enclave/site/js/core/wallet-release-chain.js";
import { censusWorld } from "./candidate/enclave/test/wallet-release/census-world.fixture.mjs";

const W = "0x0b2d009c0c9af05b12100d77f3c815fea822ee61";
const V = "0xb794c4dd0e1c5e6b72281799f282bfde7654345d";
const ID = "0xcab8fb59882d976bf4005448701149d734b0dab536d9bf46f2b5159b0b0819e9";
const Z32 = "0x" + "0".repeat(64), Z20 = "0x" + "0".repeat(40);
const SIG = "0x" + "11".repeat(64) + "1b";
const pad = (a) => "0x" + a.slice(2).padStart(64, "0");
const APPREF = "catalog://0x85f28c21b1545a05aee6661faf4b149b5dd18377fce59ad290e9f19857baab06/0", CFG = "";
const zeroReserve = () => ({ balanceWei: 0n, maxPerOpWei: 0n, epochCapWei: 0n, enabled: false, claimPolicy: 0, sponsorRelease: false, renewWindow: 0,
  minExtension: 0, claimCooldown: 0, epochSec: 0, maxGasPrice: 0n, maxClaimsPerEpoch: 0, epochIndex: 0, epochSpentWei: 0n, epochClaims: 0, lastClaimAt: 0n, lastClaimOperator: Z20 });
// R2 (mechanical): the operator continuity list is gone. Positive fixtures are now an inactive STAGING row with a
// COMPLETE fake census (census-world.fixture.mjs: wallet->vault delegated, one live envs=3 session) read by the real
// census module. Promoted PROD is no longer the positive shape (it is blocked as "prod-custody").

function world(over = {}){
  const st = {
    chainId: PINS.chainId, now: Math.floor(Date.now() / 1000), block: 53263892n, hash: "0x" + "aa".repeat(32), canon: new Map(),
    codes: { [PINS.factory]: PINS.factoryCodeHash, [V]: PINS.vaultCodeHash, [PINS.ledger]: PINS.ledgerCodeHash, [PINS.reserve]: PINS.reserveCodeHash },
    vaultFactory: PINS.factory, vaultOwner: W, vaultBook: PINS.book, isVault: true, vaultFor: V, bookLedger: PINS.ledger, schema: 16n, resLedger: PINS.ledger,
    // cab8fb59 shape: inactive, 9.5 USDC runtime balance, no escrow, no lease (held as PROD + promoted in this fixture)
    row: { id: ID, owner: V, appRef: APPREF, ports: "http:8000,udp:53,tcp:53,tcp:853", configCid: CFG, gpuMilli: 0, cpuMilli: 40, appPort: 8000,
      isPublic: true, active: false, createdAt: 1792259501n, rate: 1n, balance6: 9500000n, spent6: 0n, runner: Z32, runnerOperator: Z20, leaseUntil: 0n },
    ownerEscrow6: 0n, earn: [0n, 0n, 0n], cap: 1n, fee: [Z20, 0n], held: [1, Z32, Z32],
    oldR: zeroReserve(), newR: zeroReserve(), delegated: true, nonceUsed: new Set(), txs: new Map(), receipts: new Map(), logs: [],
    finalized: null, simulateError: null, reorgOnRead: false, releasedAt: null, postPatch: {},
  };
  Object.assign(st, over);
  const after = (b) => st.releasedAt != null && BigInt(b) >= st.releasedAt;
  const reader = {
    chainId: async () => st.chainId,
    latestBlock: async () => ({ number: st.block, hash: st.canon.get(st.block) || st.hash, timestamp: BigInt(st.blockTs ?? st.now) }),
    blockByNumber: async (n) => {
      if (n === "finalized") return st.finalized;
      n = BigInt(n);
      if (st.reorgOnRead && n === st.block) return { number: n, hash: "0x" + "bb".repeat(32), timestamp: BigInt(st.now) };
      return { number: n, hash: st.canon.get(n) || st.hash, timestamp: BigInt(st.now) };
    },
    codeHash: async (a) => st.codes[a.toLowerCase()] || "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    storageAt: async () => st.delegated ? pad("0x01") : Z32,
    simulate: async () => { if (st.simulateError) throw st.simulateError; return { data: "0x" }; },
    read: async (address, _abi, fn, args, b) => {
      const post = after(b);
      switch (fn){
        case "factory": return st.vaultFactory;
        case "owner": return st.vaultOwner;
        case "book": return st.vaultBook;
        case "isVault": return st.isVault;
        case "vaultFor": return st.vaultFor;
        case "addr": return st.bookLedger;
        case "deploymentsSchema": return st.schema;
        case "ledger": return st.resLedger;
        case "get": return post ? { ...st.row, owner: W, ...st.postPatch } : { ...st.row };
        case "ownerEscrow6": return st.ownerEscrow6;
        case "earnOf": return st.earn;
        case "capOf": return st.cap;
        case "feeOf": return st.fee;
        case "held": return post ? [0, Z32, Z32] : st.held;
        case "ownerNonceUsed": return post && st.nonceUsed.has(String(args[0]).toLowerCase());
        case "reserveOf": return String(args[1]).toLowerCase() === V ? st.oldR : st.newR;
        default: throw new Error("unexpected read " + fn);
      }
    },
    receipt: async (h) => st.receipts.get(h) || null,
    tx: async (h) => st.txs.get(h) || null,
    logs: async (q) => st.logs.filter((l) => l.address === q.address && l.topics[1] === q.topics[1] && l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock),
  };
  return { st, reader };
}

/** Include a release on the fake chain (what a successful relay submission causes). */
function mine(st, body, { omitTransfer = false, status = "success", txHash = "0x" + "cd".repeat(32), nonce } = {}){
  const R = st.block + 3n, hR = "0x" + "ee".repeat(32);
  const n = (nonce || body.args.opNonce).toLowerCase();
  st.txs.set(txHash, { to: V, input: releaseCalldata(ID, W, n, BigInt(body.args.signBefore), body.sig) });
  const logs = [{ address: V, topics: [TOPIC_VAULT_RELEASED, ID], data: pad(W) }];
  if (!omitTransfer) logs.push({ address: PINS.ledger, topics: [TOPIC_TRANSFERRED, ID, pad(V), pad(W)], data: "0x" });
  st.receipts.set(txHash, { status, blockNumber: R, blockHash: hR, to: V, logs });
  st.canon.set(R, hR);
  st.logs.push({ address: V, topics: [TOPIC_VAULT_RELEASED, ID], blockNumber: R, transactionHash: txHash });
  if (status === "success"){ st.releasedAt = R; st.nonceUsed.add(n); }
  st.block = R + 1n;
  return txHash;
}

/* ---- SDK-compatible stand-in (sdk-client.ts 290-391, transcribed; the vendor test below uses the real bundle) ---- */
const TYPES = { Release: [{ name: "deployment", type: "bytes32" }, { name: "to", type: "address" }, { name: "opNonce", type: "bytes32" }, { name: "signBefore", type: "uint64" }] };
const sdkStandIn = {
  ownerFromProvider: (provider, address) => ({ address, async signTypedData(td){
    const payload = JSON.stringify({ ...td, types: { EIP712Domain: [], ...td.types } }, (_k, v) => typeof v === "bigint" ? v.toString() : v);
    return provider.request({ method: "eth_signTypedData_v4", params: [address, payload] });
  } }),
  async ownerOperation(p){
    const opNonce = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, "0")).join("");
    const signBefore = BigInt(Math.floor(Date.now() / 1000) + (p.validSeconds ?? 600));
    const { op, ...fields } = p.op;
    const message = { ...fields, opNonce, signBefore };
    const td = { domain: { name: "Enclave Sessions", version: "1", chainId: p.chainId, verifyingContract: p.vault }, types: { Release: TYPES.Release }, primaryType: "Release", message };
    const sig = await p.owner.signTypedData(td);
    return p.relay.request("POST", "/owner", { owner: p.owner.address, vault: p.vault, op, args: message, sig });
  },
};

function harness({ over = {}, relayMode = "ok", withCensus = true, journal = new MemoryJournal(), onSign, sdk = sdkStandIn, mineOpts } = {}){
  const { st, reader } = world(over);
  const census = withCensus ? censusWorld(st).census : null;
  const events = journal.log;
  const provider = { accounts: [W], chainId: "0x2105", signs: 0,
    async request({ method }){
      events.push("provider:" + method);
      if (method === "eth_chainId") return this.chainId;
      if (method === "eth_accounts") return this.accounts.slice();
      if (method === "eth_signTypedData_v4"){ this.signs++; if (onSign) await onSign(this, st); return SIG; }
      throw new Error("provider method must not be called: " + method);
    } };
  const relay = { posts: [], async request(m, p, body){
    events.push("relay:" + m); this.posts.push(body);
    if (relayMode === "reject") throw new Error("relay 500");
    const h = mine(st, body, mineOpts);
    if (relayMode === "timeout") throw new Error("timeout");
    if (relayMode === "nohash") return {};
    return { txHash: h, block: Number(st.block) };
  } };
  const make = (writer = "0x" + "01".repeat(32)) => createReleaseController({ sdk, provider, relay, reader, journal, wallet: W, vault: V, deployment: ID,
    census, nowSec: () => st.now, writer });
  return { st, reader, provider, relay, journal, events, make, c: make() };
}
const rec = async (h) => h.journal.get(h.c.key);

test("positive: inactive funded runtime, no escrow, STAGING with a complete census -> one sign, one POST, verified", async () => {
  const h = harness();
  const pre = await h.c.check();
  assert.equal(pre.kind, "eligible", JSON.stringify(pre.blockers));
  assert.equal(pre.review.balance6, "9500000");
  assert.equal(pre.review.destination, W);
  const out = await h.c.release();
  assert.match(out.txHash, /^0x[0-9a-f]{64}$/);
  const e = h.events;
  const at = (x) => { const i = e.indexOf(x); assert.ok(i >= 0, x + " missing: " + e.join(",")); return i; };
  assert.ok(at("put:intent") < at("provider:eth_signTypedData_v4"));
  assert.ok(at("provider:eth_signTypedData_v4") < at("cas:signed"));
  assert.ok(at("cas:signed") < at("cas:dispatching") && at("cas:dispatching") < at("relay:POST") && at("relay:POST") < at("cas:submitted"));
  assert.ok(!e.includes("provider:eth_requestAccounts"));
  assert.equal(h.relay.posts.length, 1);
  const r = await rec(h);
  assert.equal(r.state, "submitted");
  assert.ok(!("sig" in r) && !JSON.stringify(r).includes(SIG.slice(2)), "signature never journaled");
  let v = await h.c.recover();
  assert.equal(v.record.state, "included");
  h.st.finalized = { number: h.st.block, hash: h.st.hash, timestamp: BigInt(h.st.now) };
  v = await h.c.recover();
  assert.equal(v.record.state, "finalized");
  assert.equal(h.provider.signs, 1); assert.equal(h.relay.posts.length, 1);
});

async function blockedWith(over, code, opts = {}){
  const h = harness({ over, ...opts });
  const s = await h.c.check();
  assert.notEqual(s.kind, "eligible");
  assert.ok(s.blockers.some((b) => b.code === code), code + " not in " + JSON.stringify(s.blockers));
  await assert.rejects(h.c.release(), ReleaseError);
  assert.equal(h.provider.signs, 0); assert.equal(h.relay.posts.length, 0);
  return s;
}

// R2: replaces the continuity-list gate. Same blocked/no-sign/no-POST assertions, census-based codes.
test("environment/content/census gate", async () => {
  await blockedWith({ held: [2, Z32, Z32] }, "unpromoted");
  await blockedWith({ held: [2, "0x" + "12".repeat(32), Z32] }, "content-drift");
  await blockedWith({ held: [2, promotedHash(APPREF, CFG), Z32] }, "prod-custody");
  await blockedWith({}, "census", { withCensus: false });                 // no census attached: nothing moves
  await blockedWith({ delegated: false }, "delegate-mapping");            // release snapshot and census disagree on the delegation slot
});

test("escrow OR gate exactly as deployed; lease, activity and reserves", async () => {
  for (const [oe, es] of [[4850000n, 0n], [0n, 4910724n]]){
    const h = harness({ over: { ownerEscrow6: oe, earn: [1n, es, 0n] } });
    assert.equal((await h.c.check()).kind, "eligible");
  }
  await blockedWith({ ownerEscrow6: 1n, earn: [1n, 1n, 0n] }, "escrow");
  await blockedWith({ row: { ...world().st.row, active: true } }, "active");
  const s = await blockedWith({ row: { ...world().st.row, runner: "0x" + "2f".repeat(32), runnerOperator: "0x1a01194c34fe3577c6d0a54feb78af6253e494e0", leaseUntil: 1000n } }, "lease");
  assert.match(s.blockers.find((b) => b.code === "lease").text, /expired but not released/);
  await blockedWith({ oldR: { ...zeroReserve(), balanceWei: 1052268502151n, enabled: true } }, "old-reserve");
  await blockedWith({ newR: { ...zeroReserve(), enabled: true } }, "new-reserve");
});

test("identity, code, chain and freshness drift all block (no fallback)", async () => {
  const s0 = world().st;
  const cases = [
    [{ codes: { ...s0.codes, [PINS.factory]: "0x" + "99".repeat(32) } }, "factory-code"],
    [{ codes: { ...s0.codes, [V]: "0x" + "99".repeat(32) } }, "vault-code"],
    [{ codes: { ...s0.codes, [PINS.ledger]: "0x" + "99".repeat(32) } }, "ledger-code"],
    [{ codes: { ...s0.codes, [PINS.reserve]: "0x" + "99".repeat(32) } }, "reserve-code"],
    [{ vaultFactory: "0x" + "77".repeat(20) }, "vault-factory"],
    [{ isVault: false }, "vault-identity"],
    [{ vaultFor: "0x" + "77".repeat(20) }, "vault-identity"],
    [{ vaultOwner: "0x" + "77".repeat(20) }, "vault-owner"],
    [{ vaultBook: "0x" + "77".repeat(20) }, "vault-book"],
    [{ bookLedger: "0x" + "77".repeat(20) }, "book-ledger"],
    [{ schema: 15n }, "ledger-schema"],
    [{ resLedger: "0x" + "77".repeat(20) }, "reserve-binding"],
    [{ chainId: 84532 }, "chain"],
    [{ blockTs: Math.floor(Date.now() / 1000) - 3600 }, "stale"],
    [{ reorgOnRead: true }, "reorg"],
  ];
  for (const [over, code] of cases) await blockedWith(over, code);
});

test("wallet provider on another chain/account blocks without requesting a connection", async () => {
  for (const patch of [{ chainId: "0x1" }, { accounts: [] }, { accounts: ["0x" + "77".repeat(20)] }]){
    const h = harness();
    Object.assign(h.provider, patch);
    const s = await h.c.check();
    assert.equal(s.kind, "blocked");
    await assert.rejects(h.c.release(), ReleaseError);
    assert.equal(h.provider.signs, 0); assert.ok(!h.events.includes("provider:eth_requestAccounts"));
  }
});

test("account change, unmount, state drift or failed simulation after the signature: nothing sent, durable cancel", async () => {
  const variants = [
    (p) => { p.accounts = ["0x" + "77".repeat(20)]; },
    (p) => { p.chainId = "0x1"; },
    (p, st, c) => { c.dispose(); },
    (p, st) => { st.row = { ...st.row, balance6: 1n }; },
    (p, st) => { st.simulateError = new Error("BadSignature()"); },
    (p, st) => { st.held = [2, Z32, Z32]; },          // R2: the row became unpromoted PROD while signing (STAGING is now the positive shape)
  ];
  for (const v of variants){
    let ctl;
    const h = harness({ onSign: (p, st) => v(p, st, ctl) });
    ctl = h.c;
    await assert.rejects(h.c.release(), (e) => e instanceof ReleaseError && e.code !== "uncertain");
    assert.equal(h.relay.posts.length, 0);
    assert.equal((await rec(h)).state, "cancelled");
  }
});

test("double click and two controllers (two tabs, one journal): one signature, one POST", async () => {
  const journal = new MemoryJournal();
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ journal, onSign: () => gate });
  const other = h.make("0x" + "02".repeat(32));
  const p1 = h.c.release();
  await assert.rejects(h.c.release(), (e) => e.code === "busy");
  const p2 = other.release();
  setTimeout(release, 10);
  const res = await Promise.allSettled([p1, p2]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(h.provider.signs, 1); assert.equal(h.relay.posts.length, 1);
});

test("journal failure at each boundary stops at the last durable point", async () => {
  const at = async (fault, expectState, posts, signs) => {
    const journal = new MemoryJournal();
    journal.faults[fault] = new Error("QuotaExceededError (injected)");
    const h = harness({ journal });
    const r = h.c.release();
    if (fault === "cas:submitted") await r; else await assert.rejects(r);
    assert.equal(h.relay.posts.length, posts, fault); assert.equal(h.provider.signs, signs, fault);
    const j = await journal.rows.get(h.c.key);
    assert.equal(j ? j.state : null, expectState, fault);
    return h;
  };
  await at("putIfAbsent", null, 0, 0);
  await at("cas:signed", "cancelled", 0, 1);
  await at("cas:dispatching", "cancelled", 0, 1);
  const h = await at("cas:submitted", "dispatching", 1, 1);
  delete h.journal.faults["cas:submitted"];
  const v = await h.make("0x" + "03".repeat(32)).recover();            // a reload: new controller, same journal
  assert.equal(v.record.state, "included");
  assert.equal(h.relay.posts.length, 1); assert.equal(h.provider.signs, 1);
  const s = harness({ journal: Object.assign(new MemoryJournal(), { faults: { get: new Error("no IndexedDB") } }) });
  assert.ok((await s.c.check()).blockers.some((b) => b.code === "storage"));
});

test("relay accepted then timed out (hash lost): uncertain, reload finds it by exact nonce, never re-signs", async () => {
  const h = harness({ relayMode: "timeout" });
  await assert.rejects(h.c.release(), (e) => e.code === "uncertain");
  assert.equal((await rec(h)).state, "uncertain");
  const reload = h.make("0x" + "04".repeat(32));
  assert.equal((await reload.check()).kind, "journal");
  await assert.rejects(reload.release(), (e) => e.code === "exists");
  const v = await reload.recover();
  assert.equal(v.record.state, "included");
  assert.equal(v.record.txHash, "0x" + "cd".repeat(32));
  assert.equal(h.provider.signs, 1); assert.equal(h.relay.posts.length, 1);
});

test("relay rejected (maybe sent): stays unresolved, no resign or repost", async () => {
  const h = harness({ relayMode: "reject" });
  await assert.rejects(h.c.release(), (e) => e.code === "uncertain");
  const v = await h.c.recover();
  assert.equal(v.outcome.status, "unresolved");
  assert.equal(v.record.state, "uncertain");
  await assert.rejects(h.c.release(), (e) => e.code === "exists");
  assert.equal(h.provider.signs, 1); assert.equal(h.relay.posts.length, 1);
});

test("wrong event / failed receipt / changed poststate / foreign nonce / reorg are refused", async () => {
  let h = harness({ mineOpts: { omitTransfer: true } });
  await h.c.release();
  assert.equal((await h.c.recover()).record.state, "conflict");
  h = harness({ mineOpts: { status: "reverted" } });
  await h.c.release();
  assert.equal((await h.c.recover()).record.state, "conflict");
  h = harness();
  await h.c.release();
  h.st.postPatch = { balance6: 1n };
  assert.equal((await h.c.recover()).record.state, "conflict");
  h = harness({ relayMode: "timeout", mineOpts: { nonce: "0x" + "42".repeat(32) } });   // a Released tx with another nonce
  await assert.rejects(h.c.release());
  const v = await h.c.recover();
  assert.notEqual(v.record.state, "included"); assert.notEqual(v.record.state, "finalized");
  h = harness();
  await h.c.release();
  assert.equal((await h.c.recover()).record.state, "included");
  h.st.canon.set(h.st.block - 1n, "0x" + "ff".repeat(32));            // the inclusion block is replaced
  const r = await h.c.recover();
  assert.equal(r.outcome.status, "pending"); assert.equal(r.record.state, "submitted");
  assert.equal(h.provider.signs, 1); assert.equal(h.relay.posts.length, 1);
});

test("an interrupted pre-dispatch record resolves only after its deadline passes on-chain", async () => {
  const h = harness({ onSign: (p, st, c) => { throw Object.assign(new Error("page closed"), { code: -1 }); } });
  const journal = h.journal;
  // a record left at "intent" by a tab that vanished mid-prompt
  await assert.rejects(h.c.release());
  const r0 = await rec(h);
  journal.rows.set(h.c.key, { ...r0, state: "intent", rev: 0 });
  assert.equal((await h.c.recover()).record.state, "intent");
  h.st.now = Number(r0.deadline) + 1;
  assert.equal((await h.c.recover()).record.state, "cancelled");
  assert.equal(h.relay.posts.length, 0);
});

test("EXACT vendored ownerOperation: wrapped signer sees generated typed data before signing, POST after", { skip: !process.env.WALLET_RELEASE_SDK_FIXTURE }, async () => {
  // root: WALLET_RELEASE_SDK_FIXTURE=/abs/path/to/copy-of-vendor-sessions.js (sha256 b61255778aa3...008e9), inert: no network is reached
  const S = await import(process.env.WALLET_RELEASE_SDK_FIXTURE);
  assert.equal(typeof S.ownerOperation, "function");
  let seenPayload = null;
  const h = harness({ sdk: S, onSign: () => {} });
  const orig = h.provider.request.bind(h.provider);
  h.provider.request = async (a) => { if (a.method === "eth_signTypedData_v4") seenPayload = JSON.parse(a.params[1]); return orig(a); };
  await h.c.release();
  assert.equal(seenPayload.primaryType, "Release");
  assert.equal(seenPayload.message.to.toLowerCase(), W);
  const e = h.events;
  assert.ok(e.indexOf("put:intent") < e.indexOf("provider:eth_signTypedData_v4"));
  assert.ok(e.indexOf("cas:dispatching") < e.indexOf("relay:POST"));
  assert.equal(h.relay.posts.length, 1);
  assert.equal(h.relay.posts[0].args.opNonce.toLowerCase(), (await rec(h)).nonce);
});

 Same actual controller, exact shipped SDK, inert wallet/relay and external MemoryJournal.
for (const boundary of ['dispatching']) test('ROOT dispose during durable '+boundary+' commit must prevent relay POST', async()=>{
 const S=await import(process.env.WALLET_RELEASE_SDK_FIXTURE);
 const h=harness({sdk:S}); const original=h.journal.cas.bind(h.journal);
 h.journal.cas=async(...args)=>{const result=await original(...args);if(args[2].state===boundary)h.c.dispose();return result;};
 await h.c.release().catch(()=>{});
 assert.equal(h.provider.signs,1,'one inert signature before revocation');
 assert.equal(h.relay.posts.length,0,'revoked view must not dispatch after persistence');
});
