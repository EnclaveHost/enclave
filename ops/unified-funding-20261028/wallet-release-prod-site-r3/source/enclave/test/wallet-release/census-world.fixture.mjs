// AUTHORED, NOT RUN. FAKE RPC providers for the real wallet-release-census.js. Four fake origins share one in-memory
// chain `st` with the controller's fake reader (same block numbers/hashes). Nothing here reaches a network, wallet,
// relay or IndexedDB. Facts are fixtures, not evidence about the live chain.
import { PINS, delegateSlotOf } from "../../site/js/core/wallet-release-chain.js";
import { CENSUS_PINS, BIRTH_HINTS, createAddress, createWalletCensus } from "../../site/js/core/wallet-release-census.js";
import { keccak256Utf8, keccak256Hex } from "../../site/js/core/keccak.js";

export const W = "0x0b2d009c0c9af05b12100d77f3c815fea822ee61";
export const V = "0xb794c4dd0e1c5e6b72281799f282bfde7654345d";
export const EMPTY = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
export const CLONE_HASH = keccak256Hex("0x363d3d373d3d3d363d73" + CENSUS_PINS.implementation.slice(2) + "5af43d82803e903d91602b57fd5bf3");
export const T = { DelegateSet: keccak256Utf8("DelegateSet(address,address,bool)"), VaultCreated: keccak256Utf8("VaultCreated(address,address)"),
  SessionOpened: keccak256Utf8("SessionOpened(bytes32,bytes32,uint64,uint256,uint8,uint256,string)") };
export const ACTIONS = { fund: 0, setActive: 1, setAppRef: 2, setConfig: 3, refund: 4 };
export const sdkAbi = { sessionVaultAbi: [{ type: "function", name: "sessionOf" }], ACTIONS };   // stand-in: the fake reads by name
const pad = (a) => "0x" + String(a).slice(2).toLowerCase().padStart(64, "0");
const w = (n) => BigInt(n).toString(16).padStart(64, "0");
const h32 = (s) => keccak256Utf8("fixture:" + s);

/* The witnessed ledger tx's real CREATE sender+nonce are not in the evidence files. The fixture searches the known
   Enclave deployers so createAddress is exercised against the REAL ledger address; root may pin it instead with
   WALLET_CENSUS_LEDGER_CREATOR=0xfrom:nonce. If neither works the positive tests FAIL (never skip). */
let creator = null;
export function ledgerCreator(){
  if (creator) return creator;
  const env = globalThis.process && process.env.WALLET_CENSUS_LEDGER_CREATOR;
  if (env){ const [from, n] = env.split(":"); creator = { from: from.toLowerCase(), nonce: BigInt(n) }; return creator; }
  for (const from of ["0xb076dcb3086a6dd306757475cace7af075582290", "0xf4b78d91911e1c064a02e4d28c69e2de6056be57"])
    for (let n = 0; n < 4096; n++) if (createAddress(from, n) === PINS.ledger) return (creator = { from, nonce: BigInt(n) });
  throw new Error("fixture: ledger CREATE sender/nonce unknown; set WALLET_CENSUS_LEDGER_CREATOR");
}
const LIB = "__$" + "a".repeat(34) + "$__";
export const CTOR = ["0x" + "11".repeat(20), "0x" + "22".repeat(20), "0x" + "33".repeat(20), "0x" + "44".repeat(20)];
export const ARTIFACT = { bytecode: { object: "0x6080" + LIB + "6000", linkReferences: { "EnclaveDeployments.sol": { EnclaveLedgerBandwidth: [{ start: 2, length: 20 }] } } }, constructorArgs: CTOR };
export const LEDGER_INPUT = "0x6080" + CENSUS_PINS.ledgerLinkedLibrary.slice(2) + "6000" + CTOR.map((a) => pad(a).slice(2)).join("");

/** Census facts on top of the controller's fake chain `st`. Default: one live envs=3 session, wallet->vault delegated. */
export function censusWorld(st, over = {}){
  const LH = BIRTH_HINTS.ledger, VH = BIRTH_HINTS.vaults[V];
  st.canon.set(LH.block, LH.blockHash); st.canon.set(VH.block, VH.blockHash);
  const cw = {
    delegations: [{ owner: W, delegate: V, allowed: true, block: 52600000n }],
    mappingOverride: new Map(),
    vaults: { [V]: { owner: W, epoch: 1n, sessions: [session("api", { envs: 3 })] } },
    unsupported: new Set(), codes: {}, births: new Map(), faults: {}, calls: {},
    ledgerTx: { from: null, nonce: null, input: LEDGER_INPUT, status: "success" }, artifact: ARTIFACT,
    ...over,
  };
  const bh = (b) => st.canon.get(BigInt(b)) || st.hash;
  // witnessed births
  const lc = () => ledgerCreator();
  cw.births.set(LH.txHash, () => ({ block: LH.block, tx: { hash: LH.txHash, blockNumber: LH.block, blockHash: LH.blockHash, from: cw.ledgerTx.from || lc().from,
    nonce: cw.ledgerTx.nonce ?? lc().nonce, to: null, input: cw.ledgerTx.input }, rc: { status: cw.ledgerTx.status, transactionHash: LH.txHash, blockNumber: LH.block,
    blockHash: LH.blockHash, contractAddress: PINS.ledger, logs: [] } }));
  cw.births.set(VH.txHash, () => ({ block: VH.block, tx: { hash: VH.txHash, blockNumber: VH.block, blockHash: VH.blockHash, from: W, nonce: 7n, to: PINS.factory, input: "0x" },
    rc: { status: "success", transactionHash: VH.txHash, blockNumber: VH.block, blockHash: VH.blockHash,
      logs: [{ address: PINS.factory, topics: [T.VaultCreated, pad(W)], data: pad(V), logIndex: 344n, blockNumber: VH.block, blockHash: VH.blockHash, transactionHash: VH.txHash }] } }));
  const mapping = (owner, delegate, b) => {
    const slot = delegateSlotOf(owner, delegate);
    if (cw.mappingOverride.has(slot)) return cw.mappingOverride.get(slot);
    let v = false;
    for (const d of cw.delegations) if (d.owner === owner && d.delegate === delegate && d.block <= BigInt(b)) v = d.allowed;
    return v;
  };
  const slotValue = (slot, b) => {
    if (cw.mappingOverride.has(slot)) return cw.mappingOverride.get(slot) ? pad("0x01") : pad("0x00");
    for (const d of cw.delegations) if (delegateSlotOf(d.owner, d.delegate) === slot) return mapping(d.owner, d.delegate, b) ? pad("0x01") : pad("0x00");
    return pad("0x00");
  };
  const allLogs = () => {
    const out = [];
    cw.delegations.forEach((d, i) => out.push({ address: PINS.ledger, topics: [T.DelegateSet, pad(d.owner), pad(d.delegate)], data: "0x" + w(d.allowed ? 1 : 0),
      blockNumber: d.block, blockHash: bh(d.block), transactionHash: h32("d" + i), logIndex: BigInt(i), removed: d.removed }));
    for (const [v, x] of Object.entries(cw.vaults)) x.sessions.forEach((s, i) => out.push({ address: v, topics: [T.SessionOpened, s.sid, s.keyHash],
      data: "0x" + w(s.openExpiresAt ?? s.expiresAt) + w(s.actions) + w(s.envs) + w(0) + w(160) + w(0), blockNumber: s.block, blockHash: bh(s.block), transactionHash: h32("s" + v + i), logIndex: BigInt(100 + i) }));
    for (const [, f] of cw.births){ const x = f(); for (const l of x.rc.logs) out.push({ ...l }); }
    return out;
  };
  const make = (origin, span, { archive = true } = {}) => {
    const tick = (k) => { cw.calls[origin + ":" + k] = (cw.calls[origin + ":" + k] || 0) + 1;
      if (cw.faults.down === origin) throw new Error("429 Too Many Requests"); };
    return {
      origin, maxLogSpan: span,
      chainId: async () => { tick("chainId"); return st.chainId; },
      latestBlock: async () => { tick("latest"); return { number: st.block, hash: bh(st.block), timestamp: BigInt(st.now) }; },
      blockByNumber: async (n) => { tick("block"); n = BigInt(n); if (n > st.block) return null;
        if (cw.faults.foreignBlock === origin) return { number: n, hash: "0x" + "9f".repeat(32), timestamp: BigInt(st.now) };
        return { number: n, hash: bh(n), timestamp: BigInt(st.now) }; },
      blockTxHashes: async (n) => { tick("blockTx"); n = BigInt(n);
        return { number: n, hash: bh(n), timestamp: BigInt(st.now), transactions: [...cw.births.entries()].filter(([, f]) => f().block === n).map(([h]) => h) }; },
      codeHash: async (a, b) => { tick("code"); a = a.toLowerCase(); b = BigInt(b);
        if (!archive && b < st.block - 128n) throw new Error("archive state requires an API token");
        if (a === PINS.factory) return b < CENSUS_PINS.factoryCreationBlock ? EMPTY : PINS.factoryCodeHash;
        if (cw.codes[a]) return cw.codes[a];
        const known = { [PINS.ledger]: PINS.ledgerCodeHash, [CENSUS_PINS.implementation]: CENSUS_PINS.implementationCodeHash, [CENSUS_PINS.library]: CENSUS_PINS.libraryCodeHash };
        if (known[a]) return known[a];
        return cw.vaults[a] ? CLONE_HASH : EMPTY; },
      read: async (address, _abi, fn, args, b) => { tick("read:" + fn); address = address.toLowerCase();
        const v = cw.vaults[address];
        switch (fn){
          case "implementation": return CENSUS_PINS.implementation;
          case "isVault": return address === PINS.factory ? !!cw.vaults[String(args[0]).toLowerCase()] : cw.unsupported.has(String(args[0]).toLowerCase());
          case "vaultFor": return String(args[0]).toLowerCase() === W ? V : "0x" + "0".repeat(40);
          case "factory": return PINS.factory;
          case "owner": return v.owner;
          case "book": return PINS.book;
          case "deploymentsSchema": return 16n;
          case "epoch": return v.epoch;
          case "sessionOf": {
            const s = v.sessions.find((x) => x.sid === String(args[0]).toLowerCase());
            const live = s.state === 1 && s.epoch === v.epoch && BigInt(st.now) <= s.expiresAt;
            const anyApp = cw.faults.disagree === origin ? !s.anyApp : s.anyApp;     // internally valid, but differs between origins
            return [{ keyHash: s.keyHash, measurement: "0x" + "0".repeat(64), actions: s.actions, expiresAt: s.expiresAt, epoch: s.epoch, envs: s.envs, state: s.state, anyApp }, live, s.apps];
          }
          default: throw new Error("fixture: unexpected census read " + fn);
        } },
      storageAt: async (a, slot, b) => { tick("storage"); return slotValue(slot, b); },
      receipt: async (h) => { tick("receipt"); const f = cw.births.get(h.toLowerCase()); return f ? f().rc : null; },
      tx: async (h) => { tick("tx"); const f = cw.births.get(h.toLowerCase()); return f ? f().tx : null; },
      logs: async (q) => { tick("logs");
        if (cw.faults.rateLimit === origin) throw new Error("429 rate limited: 1200 requests / 60s");
        const lo = BigInt(q.fromBlock), hi = BigInt(q.toBlock);
        if (hi - lo + 1n > BigInt(span || 0)) throw new Error("block range too large");
        const f1 = q.topics[1], match1 = (t) => f1 == null || (Array.isArray(f1) ? f1.includes(t) : f1 === t);
        const out = allLogs().filter((l) => l.address === q.address.toLowerCase() && l.topics[0] === q.topics[0] && match1(l.topics[1]) &&
          l.blockNumber >= lo && l.blockNumber <= hi && l.blockNumber <= st.block);
        if (cw.faults.truncate === origin && out.length) return Array.from({ length: 2048 }, () => out[0]);
        if (cw.faults.dupe === origin && out.length) return [...out, out[0]];
        return out; },
    };
  };
  const readers = {
    provenance: [make("https://api.example", 20000), make("https://blast.example", 10)],
    history: [make("https://api.example", 20000), make("https://publicnode.example", 20000, { archive: false })],
  };
  const census = createWalletCensus({ wallet: W, vault: V, sdk: sdkAbi, readers, loadLedgerArtifact: async () => cw.artifact, nowSec: () => st.now });
  return { cw, readers, census, slotValue };
}
let sidN = 0;
/** A SessionOpened + sessionOf row. state 1 = open. */
export function session(label, o = {}){
  const sid = h32("sid:" + label + ":" + (sidN++));
  return { sid, keyHash: h32("key:" + label), actions: (1n << 0n) | (1n << 1n) | (1n << 2n) | (1n << 3n), envs: 3, state: 1, epoch: 1n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86400), anyApp: true, apps: [], block: 52700000n, ...o };
}
