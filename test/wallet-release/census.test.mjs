// node --test enclave/test/wallet-release/
// Real wallet-release-census.js + real controller + real chain gate over FAKE RPC origins (census-world.fixture.mjs),
// a fake wallet provider, a fake relay and MemoryJournal (NOT IndexedDB). Proves nothing about live Base history,
// provider behaviour, browser storage or installed host/API/relay consumers.
import test from "node:test";
import assert from "node:assert/strict";
import { createReleaseController, ReleaseError } from "../../site/js/core/wallet-release-controller.js";
import { MemoryJournal } from "../../site/js/core/wallet-release-store.js";
import { PINS, promotedHash, readSnapshot } from "../../site/js/core/wallet-release-chain.js";
import { evaluateRelease, createAddress } from "../../site/js/core/wallet-release-census.js";
import { censusWorld, session, W, V, CLONE_HASH, ARTIFACT, LEDGER_INPUT, ledgerCreator } from "./census-world.fixture.mjs";

const ID = "0xcab8fb59882d976bf4005448701149d734b0dab536d9bf46f2b5159b0b0819e9";
const Z32 = "0x" + "0".repeat(64), Z20 = "0x" + "0".repeat(40), SIG = "0x" + "11".repeat(64) + "1b";
const pad = (a) => "0x" + a.slice(2).padStart(64, "0");
const X = "0x" + "5e".repeat(20), OTHER = "0x" + "6f".repeat(20);
const zr = () => ({ balanceWei: 0n, maxPerOpWei: 0n, epochCapWei: 0n, enabled: false, claimPolicy: 0, sponsorRelease: false, renewWindow: 0, minExtension: 0,
  claimCooldown: 0, epochSec: 0, maxGasPrice: 0n, maxClaimsPerEpoch: 0, epochIndex: 0, epochSpentWei: 0n, epochClaims: 0, lastClaimAt: 0n, lastClaimOperator: Z20 });

function setup({ over = {}, cw = {}, onSign, relayMode = "ok" } = {}){
  const st = { chainId: 8453, now: Math.floor(Date.now() / 1000), block: 53263892n, hash: "0x" + "aa".repeat(32), canon: new Map(),
    row: { id: ID, owner: V, appRef: "catalog://x/0", ports: "http:8000", configCid: "", gpuMilli: 0, cpuMilli: 40, appPort: 8000, isPublic: true, active: false,
      createdAt: 1n, rate: 1n, balance6: 9500000n, spent6: 0n, runner: Z32, runnerOperator: Z20, leaseUntil: 0n },
    held: [1, Z32, Z32], ownerEscrow6: 0n, earn: [0n, 0n, 0n], ...over };
  const world = censusWorld(st, cw);
  const reader = {   // the release snapshot reader (origin of cfg.rpc); same fake chain
    chainId: async () => st.chainId,
    latestBlock: async () => ({ number: st.block, hash: st.canon.get(st.block) || st.hash, timestamp: BigInt(st.now) }),
    blockByNumber: async (n) => n === "finalized" ? null : { number: BigInt(n), hash: st.canon.get(BigInt(n)) || st.hash, timestamp: BigInt(st.now) },
    codeHash: async (a) => ({ [PINS.factory]: PINS.factoryCodeHash, [V]: PINS.vaultCodeHash, [PINS.ledger]: PINS.ledgerCodeHash, [PINS.reserve]: PINS.reserveCodeHash })[a.toLowerCase()],
    storageAt: async (a, slot, b) => world.slotValue(slot, b),
    simulate: async () => ({ data: "0x" }),
    read: async (address, _abi, fn, args) => ({ factory: PINS.factory, owner: W, book: PINS.book, isVault: true, vaultFor: V, addr: PINS.ledger, deploymentsSchema: 16n,
      ledger: PINS.ledger, get: { ...st.row }, ownerEscrow6: st.ownerEscrow6, earnOf: st.earn, capOf: 1n, feeOf: [Z20, 0n], held: st.held, ownerNonceUsed: false, reserveOf: zr() })[fn],
    receipt: async () => null, tx: async () => null, logs: async () => [],
  };
  const journal = new MemoryJournal();
  const provider = { signs: 0, async request({ method }){ journal.log.push("provider:" + method);
    if (method === "eth_chainId") return "0x2105"; if (method === "eth_accounts") return [W];
    if (method === "eth_signTypedData_v4"){ this.signs++; if (onSign) await onSign(st, world.cw, ctl); return SIG; } throw new Error(method); } };
  const relay = { posts: [], async request(m, p, body){ journal.log.push("relay:" + m); this.posts.push(body); if (relayMode === "timeout") throw new Error("timeout"); return { txHash: "0x" + "cd".repeat(32) }; } };
  const sdk = { ownerFromProvider: (pr, address) => ({ address, signTypedData: (td) => pr.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(td, (_k, v) => typeof v === "bigint" ? String(v) : v)] }) }),
    async ownerOperation(p){ const { op, ...f } = p.op; const message = { ...f, opNonce: "0x" + "ab".repeat(32), signBefore: BigInt(st.now + 600) };
      const td = { domain: { name: "Enclave Sessions", version: "1", chainId: p.chainId, verifyingContract: p.vault }, primaryType: "Release",
        types: { Release: [{ name: "deployment", type: "bytes32" }, { name: "to", type: "address" }, { name: "opNonce", type: "bytes32" }, { name: "signBefore", type: "uint64" }] }, message };
      const sig = await p.owner.signTypedData(td); return p.relay.request("POST", "/owner", { owner: p.owner.address, vault: p.vault, op, args: message, sig }); } };
  const make = (census = world.census) => createReleaseController({ sdk, provider, relay, reader, journal, census, wallet: W, vault: V, deployment: ID, nowSec: () => st.now, writer: "0x" + "01".repeat(32) });
  const ctl = make();
  return { st, ...world, reader, journal, provider, relay, c: ctl, make };
}
const codes = (s) => s.blockers.map((b) => b.code);
async function blocked(h, code){
  const s = await h.c.check();
  assert.ok(codes(s).includes(code), code + " not in " + JSON.stringify(s.blockers));
  await assert.rejects(h.c.release(), ReleaseError);
  assert.equal(h.provider.signs, 0); assert.equal(h.relay.posts.length, 0);
  return s;
}

test("pins: the reviewed vault runtime is exactly the clone of the pinned implementation; CREATE derivation finds the real ledger", () => {
  assert.equal(CLONE_HASH, PINS.vaultCodeHash);
  const c = ledgerCreator();
  assert.equal(createAddress(c.from, c.nonce), PINS.ledger);
});

test("positive: scanner -> predicate -> controller, inactive STAGING, envs3 session, 9.5 USDC runtime balance, no escrow", async () => {
  const h = setup();
  const s = await h.c.check();
  assert.equal(s.kind, "eligible", JSON.stringify(s.blockers));
  assert.equal(s.review.balance6, "9500000");
  assert.equal(s.review.census.preserved.length, 1);
  assert.match(s.review.census.preserved[0], /loses setAppRef\/setConfig/);
  assert.match(s.review.authorityAfter, /lose setAppRef\/setConfig/);
  assert.equal(s.review.census.checkpoint.number, String(h.st.block));
  await h.c.release();
  assert.equal(h.provider.signs, 1); assert.equal(h.relay.posts.length, 1);
  const e = h.journal.log;
  assert.ok(e.indexOf("put:intent") < e.indexOf("provider:eth_signTypedData_v4") && e.indexOf("cas:dispatching") < e.indexOf("relay:POST"));
  const r = await h.journal.get(h.c.key);
  assert.equal(r.state, "submitted"); assert.match(r.census.policyHash, /^0x[0-9a-f]{64}$/);
  // one history build; eligibility, pre-sign and pre-dispatch each appended a tail and re-read state
  assert.equal(h.census.stats.historyBuilds, 1); assert.equal(h.census.stats.provenanceBuilds, 1); assert.ok(h.census.stats.tails >= 4);
});

test("staging-only session is narrowed and disclosed; without wallet delegation envs3 is narrowed too", async () => {
  let h = setup({ cw: { vaults: { [V]: { owner: W, epoch: 1n, sessions: [session("s", { envs: 1 })] } } } });
  let s = await h.c.check();
  assert.equal(s.kind, "eligible", JSON.stringify(s.blockers));
  assert.match(s.review.census.narrowed.join(" "), /staging only\) loses access/);
  h = setup({ cw: { delegations: [] } });
  s = await h.c.check();
  assert.equal(s.kind, "eligible", JSON.stringify(s.blockers));
  assert.match(s.review.census.narrowed.join(" "), /has not delegated/);
});

test("prod-only live session would newly gain access -> blocked; expired/terminated/epoch-revoked prod-only rows are history, not authority", async () => {
  await blocked(setup({ cw: { vaults: { [V]: { owner: W, epoch: 1n, sessions: [session("p", { envs: 2 })] } } } }), "prod-only-gain");
  await blocked(setup({ cw: { delegations: [], vaults: { [V]: { owner: W, epoch: 1n, sessions: [session("p", { envs: 2 })] } } } }), "prod-only-gain");  // no delegation is not proof funding refuses
  const h = setup({ cw: { vaults: { [V]: { owner: W, epoch: 2n, sessions: [session("e", { envs: 2, expiresAt: 1n }), session("t", { envs: 2, state: 2 }), session("r", { envs: 2, epoch: 1n }),
    session("ok", { envs: 3, epoch: 2n })] } } } });
  const s = await h.c.check();
  assert.equal(s.kind, "eligible", JSON.stringify(s.blockers));
  assert.equal(s.review.census.counts.sessions, 4); assert.equal(s.review.census.counts.liveSessions, 1);
});

test("other wallet-delegated supported vault: live prod grant gains access -> blocked; its history is discovered by receipt-qualified scan", async () => {
  const h = setup({ cw: { delegations: [{ owner: W, delegate: V, allowed: true, block: 52600000n }, { owner: W, delegate: X, allowed: true, block: 52800000n }],
    vaults: { [V]: { owner: W, epoch: 1n, sessions: [session("a")] }, [X]: { owner: OTHER, epoch: 1n, sessions: [session("x", { envs: 2, block: 52900000n })] } } } });
  const txh = "0x" + "71".repeat(32), bx = 52850000n, hx = "0x" + "72".repeat(32);
  h.st.canon.set(bx, hx);
  const { T } = await import("./census-world.fixture.mjs");
  h.cw.births.set(txh, () => ({ block: bx, tx: { hash: txh, blockNumber: bx, blockHash: hx, from: OTHER, nonce: 1n, to: PINS.factory, input: "0x" },
    rc: { status: "success", transactionHash: txh, blockNumber: bx, blockHash: hx, logs: [{ address: PINS.factory, topics: [T.VaultCreated, pad(OTHER)], data: pad(X), logIndex: 3n, blockNumber: bx, blockHash: hx, transactionHash: txh }] } }));
  const s = await blocked(h, "other-vault-gain");
  assert.equal(h.census.stats.vaultHistoryBuilds, 1);
  // without a creation event for that vault: explicit incomplete history, never "no grants"
  const g = setup({ cw: { delegations: [{ owner: W, delegate: V, allowed: true, block: 52600000n }, { owner: W, delegate: X, allowed: true, block: 52800000n }],
    vaults: { [V]: { owner: W, epoch: 1n, sessions: [session("a")] }, [X]: { owner: OTHER, epoch: 1n, sessions: [] } } } });
  await blocked(g, "vault-birth");
  assert.ok(s);
});

test("unknown delegate blocks; revoked delegate is retained history only; event/mapping mismatch blocks; source-vault delegate blocks", async () => {
  await blocked(setup({ cw: { delegations: [{ owner: W, delegate: V, allowed: true, block: 52600000n }, { owner: W, delegate: OTHER, allowed: true, block: 52610000n }] } }), "unknown-delegate");
  const h = setup({ cw: { delegations: [{ owner: W, delegate: V, allowed: true, block: 52600000n }, { owner: W, delegate: OTHER, allowed: true, block: 52610000n },
    { owner: W, delegate: OTHER, allowed: false, block: 52620000n }] } });
  const s = await h.c.check();
  assert.equal(s.kind, "eligible", JSON.stringify(s.blockers)); assert.equal(s.review.census.counts.delegations, 2);
  const m = setup();
  const { delegateSlotOf } = await import("../../site/js/core/wallet-release-chain.js");
  m.cw.mappingOverride.set(delegateSlotOf(W, OTHER), true);           // storage says delegated, no event ever emitted -> not in replay
  m.cw.delegations.push({ owner: W, delegate: OTHER, allowed: false, block: 52610000n });
  await blocked(m, "delegate-mapping");
  await blocked(setup({ cw: { delegations: [{ owner: W, delegate: V, allowed: true, block: 52600000n }, { owner: V, delegate: OTHER, allowed: true, block: 52610000n }] } }), "source-delegate");
});

test("session or delegate added during the wallet prompt: nothing sent, durable cancel", async () => {
  const variants = [
    // events land in the NEW block (st.block + 1), i.e. in the tail after the pre-sign anchor
    (st, cw) => { cw.vaults[V].sessions.push(session("late", { envs: 2, block: st.block + 1n })); },        // newly opened prod-only
    (st, cw) => { cw.vaults[V].sessions.push(session("late3", { envs: 3, block: st.block + 1n })); },       // harmless but not what was reviewed
    (st, cw) => { cw.vaults[V].sessions[0].expiresAt += 1000n; },                                           // extended/changed live row
    (st, cw) => { cw.delegations.push({ owner: W, delegate: OTHER, allowed: true, block: st.block + 1n }); },  // new unknown delegate
    (st, cw) => { cw.delegations.push({ owner: W, delegate: X, allowed: true, block: st.block + 1n }); cw.vaults[X] = { owner: OTHER, epoch: 1n, sessions: [] }; },  // new vault: no extend
  ];
  for (const v of variants){
    const h = setup({ onSign: async (st, cw) => { v(st, cw); st.block += 1n; } });
    await assert.rejects(h.c.release(), (e) => e instanceof ReleaseError && e.code !== "uncertain");
    assert.equal(h.relay.posts.length, 0); assert.equal(h.provider.signs, 1);
    assert.equal((await h.journal.get(h.c.key)).state, "cancelled");
  }
});

test("incomplete reads are explicit blockers, never absence: rate limit, range cap, truncated page, duplicate log, archive absence, disagreement, one origin", async () => {
  await blocked(setup({ cw: { faults: { rateLimit: "https://publicnode.example" } } }), "read");
  await blocked(setup({ cw: { faults: { truncate: "https://api.example" } } }), "log-cap");
  await blocked(setup({ cw: { faults: { dupe: "https://publicnode.example" } } }), "duplicate-log");
  await blocked(setup({ cw: { faults: { disagree: "https://publicnode.example" } } }), "quorum-disagree");
  const r = setup(); r.readers.history[1].maxLogSpan = 10;                       // a 10-block log cap is a range-cap blocker, not a silent shrink
  await blocked(r, "range-cap");
  const o = setup(); o.readers.history[1].origin = "https://api.example";       // two readers, one origin
  await blocked(o, "quorum");
  const a = setup(); a.readers.provenance[1] = a.readers.history[1];            // provenance peer without archive getCode
  a.readers.provenance[1] = { ...a.readers.history[1], origin: "https://noarchive.example" };
  const s = await a.c.check();                                                  // known witnesses need no archive: still complete
  assert.equal(s.kind, "eligible", JSON.stringify(s.blockers));
});

test("creation-boundary evidence: initcode, constructor args, artifact absence, failed or non-canonical witness", async () => {
  await blocked(setup({ cw: { ledgerTx: { input: LEDGER_INPUT.slice(0, -2) + "ff", status: "success" } } }), "ledger-ctor-args");
  await blocked(setup({ cw: { ledgerTx: { input: "0x6081" + LEDGER_INPUT.slice(6), status: "success" } } }), "ledger-initcode");
  await blocked(setup({ cw: { artifact: null } }), "ledger-initcode");
  await blocked(setup({ cw: { artifact: { ...ARTIFACT, constructorArgs: [] } } }), "ledger-ctor-args");
  await blocked(setup({ cw: { ledgerTx: { input: LEDGER_INPUT, status: "reverted" } } }), "birth-witness");
  await blocked(setup({ cw: { ledgerTx: { input: LEDGER_INPUT, status: "success", from: "0x" + "12".repeat(20), nonce: 0n } } }), "birth-witness");
  const h = setup();
  const { BIRTH_HINTS } = await import("../../site/js/core/wallet-release-census.js");
  h.st.canon.set(BIRTH_HINTS.vaults[V].block, "0x" + "e0".repeat(32));         // the vault birth block is no longer canonical
  await blocked(h, "birth-witness");
});

test("reorged cached anchor is discarded and rebuilt; a stale, foreign or caller-built census is rejected", async () => {
  const h = setup();
  assert.equal((await h.c.check()).kind, "eligible");
  h.st.canon.set(h.st.block, "0x" + "e1".repeat(32)); h.st.block += 1n;        // the old anchor block was replaced
  assert.ok(codes(await h.c.check()).includes("census-reorg"));
  assert.equal((await h.c.check()).kind, "eligible");
  assert.equal(h.census.stats.historyBuilds, 2);
  const snap = await readSnapshot(h.reader, { wallet: W, vault: V, id: ID }, h.st.now);
  const real = await h.census.qualify(snap);
  assert.equal(evaluateRelease(snap, real).eligible, true);
  assert.ok(codes(evaluateRelease(snap, { ...real })).includes("census-forged"));
  const later = { ...snap, block: { ...snap.block, number: String(BigInt(snap.block.number) + 1n) } };
  assert.ok(codes(evaluateRelease(later, real)).includes("census-stale"));
  const foreign = setup(); foreign.cw.faults.foreignBlock = "https://publicnode.example";
  assert.ok(codes(await foreign.c.check()).includes("census-snapshot"));
  const other = setup();
  await assert.rejects(other.make({ wallet: W, vault: V, qualify: real.census.qualify }).release(), (e) => e.code === "census");   // look-alike object
});

test("concurrent rows share one history build (cached history is not cached permission)", async () => {
  const h = setup();
  const ids = ["0x" + "01".repeat(32), "0x" + "02".repeat(32), ID];
  const cs = ids.map((d) => createReleaseController({ sdk: {}, provider: { request: async ({ method }) => method === "eth_chainId" ? "0x2105" : [W] }, relay: {}, reader: h.reader,
    journal: h.journal, census: h.census, wallet: W, vault: V, deployment: d, nowSec: () => h.st.now }));
  const out = await Promise.all(cs.map((c) => c.check()));
  assert.equal(h.census.stats.historyBuilds, 1); assert.equal(h.census.stats.provenanceBuilds, 1);
  assert.equal(out[2].kind, "eligible", JSON.stringify(out[2].blockers));
  assert.equal(out[2].review.census.counts.sessions, out[0].review ? out[0].review.census.counts.sessions : 1);
});

test("PROD stays outside this path: unpromoted, drifted and promoted PROD are blocked", async () => {
  await blocked(setup({ over: { held: [2, Z32, Z32] } }), "unpromoted");
  await blocked(setup({ over: { held: [2, "0x" + "12".repeat(32), Z32] } }), "content-drift");
  await blocked(setup({ over: { held: [2, promotedHash("catalog://x/0", ""), Z32] } }), "prod-custody");
});

test("invalidation during final persistence: no POST; unknown outcome is never re-signed or re-sent", async () => {
  const h = setup();
  const cas = h.journal.cas.bind(h.journal);
  h.journal.cas = async (...a) => { const r = await cas(...a); if (a[2].state === "dispatching") h.c.dispose(); return r; };
  await h.c.release().catch(() => {});
  assert.equal(h.provider.signs, 1); assert.equal(h.relay.posts.length, 0);
  const t = setup({ relayMode: "timeout" });
  await assert.rejects(t.c.release(), (e) => e.code === "uncertain");
  await assert.rejects(t.c.release(), (e) => e.code === "exists");
  assert.equal(t.provider.signs, 1); assert.equal(t.relay.posts.length, 1);
});

for (const missing of [undefined, null]) test('ROOT absent delegate storage must refuse: '+String(missing), async()=>{
 const h=setup({cw:{delegations:[]}});
 for(const r of h.readers.history)r.storageAt=async()=>missing;
 await blocked(h,'delegate-mapping');
});
