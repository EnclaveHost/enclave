// AUTHORED, NOT RUN. node --test enclave/test/wallet-release/   (root sets WALLET_CENSUS_LEDGER_CREATOR, see report)
// Explicit owner-elected PROD path: real chain gate, census, release + promotion controllers, MemoryJournal (NOT
// IndexedDB), fake RPC/provider/relay. The "EXACT shipped SDK" tests import ../shipped-sessions.mjs unconditionally.
// Proves nothing about live Base, browser IndexedDB, installed hosts or the relay.


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
export function setup({ over = {}, cw = {}, journal = new MemoryJournal(), onSign, relayMode = "ok", nonce, sdk: realSdk, mutate } = {}){
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
