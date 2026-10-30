/* ============================================================
   Wallet release: the owner-controlled authority census. Replaces the
   empty per-deployment continuity list. Before a STAGING row may move
   from the vault to the wallet, this reads - from the chain, never from
   a caller, relay row or static list - every ledger delegation of the
   wallet and of the source vault and every session the source vault (and
   any supported wallet-delegated vault) ever opened, and decides whether
   the move only preserves or narrows session/delegate authority.

   Method stages, each agreed by TWO distinct provider origins at one
   canonical block (rpc-diagnostic-r2 / r3): creation provenance on the
   provenance pair (archive-capable), complete log history and current
   state on the history pair (wide eth_getLogs). Stages join through the
   exact canonical birth block/hash, successful receipt and event, and
   the release snapshot block hash. No provider must implement every
   method; no failed quorum is downgraded to one provider.

   Sources (read-only, as in evidence/census/r3/read.mjs): ledger rev16d
   DelegateSet + private slot 23, SessionVault v2 SessionOpened/sessionOf/
   epoch, factory VaultCreated (createVault emits only after a fresh
   CREATE2 clone + initialize; returns without emitting if it exists).
   Policy: evidence/policy/REVIEW.md (_requireHeldEnv 1104, dispatch
   1037-1050, fund 1013-1034, host refusal not app-list gated).

   Assurance: provider-agreed history and state, not a cryptographic
   log-completeness proof, finality, installed-consumer evidence or an
   atomic guarantee. Nothing here signs, sends, grants or revokes.
   ============================================================ */
import { keccak256Hex, keccak256Utf8 } from "./keccak.js";
import { PINS, MAX_BLOCK_AGE_SEC, delegateSlotOf, canon, evaluate, viemReader } from "./wallet-release-chain.js";

/* Supported code identity: cryptographic compatibility pins, not approval of any user, wallet or app. */
export const CENSUS_PINS = Object.freeze({
  factoryCreationBlock: 52286277n,      // pinned factory artifact; justified by archive getCode boundary (factoryBoundary)
  implementation: "0x66c76a47209f44612343dbeab98b8ef77ad01f65",
  implementationCodeHash: "0x3dd35d4c4bdf112e2ded90da36a16510bfe938a0c9b8b9ed4414698323efb76e",
  library: "0x5510ae9fed97577d75c69545384af7d8bad05027",
  libraryCodeHash: "0xe1535a3f96d34230e84afa199f2f2eab3a1c2f412be64d531d34d4a566680bc7",
  ledgerLinkedLibrary: "0x3dfee18b44b7ecd389eca78da10b6ad032802215",   // EnclaveLedgerBandwidth linked into ledger initcode
  unsupportedFactories: Object.freeze(["0x00bb59c40768aa56e292b4e789f9f3b5826e3a8d"]),
});
/* Public discovery witnesses (evidence/census/r3/discovery-hints.json). Scan-start hints ONLY: every field is
   re-validated against two providers' canonical block, transaction and successful receipt before it bounds a scan.
   A missing hint means bounded receipt-qualified discovery or an explicit incomplete result, never "no grants". */
export const BIRTH_HINTS = Object.freeze({
  ledger: Object.freeze({ block: 52515705n, blockHash: "0x583fbb7a7ea5ce7a05aae1e88c7b8c38c502ce687ed11b9b3e38eb361842b9ce",
    txHash: "0xddc85def2d8bc739831b931a60ae2d0597e7e922812c3c582e9dbd5984609a89" }),
  vaults: Object.freeze({
    "0xb794c4dd0e1c5e6b72281799f282bfde7654345d": Object.freeze({ block: 52286637n, blockHash: "0xcc27ceab340fd86ca60f7f16d5fbdae051ed1968427a2db0a8cc5e8a6de14162",
      txHash: "0x82eadf6bcf3253c6094d27df0af0e0dad3f34756ede0aa79197bf66071b846f3", logIndex: 344n }),
  }),
});
/* rpc-diagnostic-r2: blast = archive getCode but a 10-block log cap; publicnode = 20000-block logs, no tokenless archive. */
export const CENSUS_RPCS = Object.freeze({
  provenance: Object.freeze([{ url: "https://api.enclave.host/rpc/base", maxLogSpan: 0 }, { url: "https://base-mainnet.public.blastapi.io", maxLogSpan: 0 }]),
  history: Object.freeze([{ url: "https://api.enclave.host/rpc/base", maxLogSpan: 20000 }, { url: "https://rpc.baseazul.dev", maxLogSpan: 1000 }]),
});
export const BOUNDS = Object.freeze({ rangesPerStream: 1024, logsPerResponse: 2048, eventsPerStream: 2048, delegates: 64, vaults: 8,
  sessionsPerVault: 256, appsPerSession: 8, callsPerReaderPerCheck: 2200, catchUpPolls: 2, catchUpMs: 1500 });
export const LIMITS = Object.freeze([
  "Two providers agreed on these logs and state at one block; that is not a cryptographic proof of log completeness or finality.",
  "This reads the chain only. Installed host, API and relay behaviour, requests already in flight and owner signatures you already gave are not covered.",
  "Not atomic: the release call carries no expected state, so a grant, delegation or reserve change between the last check and inclusion is detected afterwards, not prevented.",
  "Anyone can still deposit into the vault's gas reserve; the reserve check is a preflight, not a lock.",
  "Complete delegation history relies on the reviewed ledger constructor starting with no delegations, checked against its creation input.",
]);

const EMPTY_CODE = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
const TOPIC = Object.freeze({
  DelegateSet: keccak256Utf8("DelegateSet(address,address,bool)"),
  VaultCreated: keccak256Utf8("VaultCreated(address,address)"),
  SessionOpened: keccak256Utf8("SessionOpened(bytes32,bytes32,uint64,uint256,uint8,uint256,string)"),
});
const fn = (name, inputs, outputs) => ({ type: "function", name, stateMutability: "view", inputs: inputs.map((type) => ({ type })), outputs: outputs.map((type) => ({ type })) });
const ABI = Object.freeze({
  factory: [fn("isVault", ["address"], ["bool"]), fn("vaultFor", ["address"], ["address"]), fn("implementation", [], ["address"])],
  vault: [fn("factory", [], ["address"]), fn("owner", [], ["address"]), fn("book", [], ["address"]), fn("epoch", [], ["uint64"])],
  ledger: [fn("deploymentsSchema", [], ["uint256"])],
});
const lower = (a) => String(a == null ? "" : a).toLowerCase();
const short = (e) => String((e && (e.shortMessage || e.message)) || e).replace(/https?:\/\/[^\s)]+/g, "[RPC]").slice(0, 200);
const padAddr = (a) => "0x" + lower(a).replace(/^0x/, "").padStart(64, "0");
const min = (a, b) => a < b ? a : b;
const okStatus = (s) => s === "success" || s === 1 || s === "0x1" || s === 1n;
const cloneHash = keccak256Hex("0x363d3d373d3d3d363d73" + CENSUS_PINS.implementation.slice(2) + "5af43d82803e903d91602b57fd5bf3");

export class CensusIncomplete extends Error {
  constructor(code, message, extra = {}){ super(message); this.code = code; Object.assign(this, extra); }
}
const inc = (code, msg, extra) => new CensusIncomplete(code, msg, extra);
const need = (v, code, msg) => { if (!v) throw inc(code, msg); };

/* Results and instances this module issued. A caller-built object with the same fields is never accepted. */
const ISSUED = new WeakSet(), INSTANCES = new WeakSet();

/* ---- pure helpers ----------------------------------------------------------------------------------------------- */
/** CREATE address = keccak(rlp([sender, nonce]))[12:]. */
export function createAddress(from, nonce){
  const n = BigInt(nonce);
  let nb;
  if (n === 0n) nb = "80";
  else if (n < 128n) nb = n.toString(16).padStart(2, "0");
  else { let h = n.toString(16); if (h.length % 2) h = "0" + h; nb = (0x80 + h.length / 2).toString(16) + h; }
  const payload = "94" + lower(from).replace(/^0x/, "") + nb;
  return "0x" + keccak256Hex("0x" + (0xc0 + payload.length / 2).toString(16) + payload).slice(-40);
}
/** The ledger's creation input must be the reviewed linked initcode + exactly four canonical address arguments. */
export function checkLedgerInitcode(input, artifact){
  const bc = artifact && (artifact.bytecode || (artifact.evm && artifact.evm.bytecode));
  const obj = bc && typeof bc.object === "string" ? lower(bc.object).replace(/^0x/, "") : "";
  need(obj, "ledger-initcode", "The reviewed ledger creation artifact is not available here, so the ledger's starting delegation state cannot be checked.");
  let linked = obj, links = 0;
  for (const [file, libs] of Object.entries(bc.linkReferences || {}))
    for (const [lib, refs] of Object.entries(libs)){
      need(lib === "EnclaveLedgerBandwidth", "ledger-initcode", "The ledger artifact links an unexpected library (" + file + ":" + lib + ").");
      for (const { start, length } of refs){
        need(length === 20 && Number.isInteger(start), "ledger-initcode", "Malformed ledger artifact link reference.");
        linked = linked.slice(0, start * 2) + CENSUS_PINS.ledgerLinkedLibrary.slice(2) + linked.slice(start * 2 + 40);
        links++;
      }
    }
  need(links > 0 && /^[0-9a-f]+$/.test(linked), "ledger-initcode", "The ledger artifact is not fully linked.");
  const h = lower(input).replace(/^0x/, "");
  need(h.startsWith(linked), "ledger-initcode", "The ledger's creation input is not the reviewed creation bytecode.");
  const tail = h.slice(linked.length);
  need(tail.length === 256, "ledger-initcode", "The ledger's constructor arguments are not exactly four words.");
  const args = [0, 1, 2, 3].map((i) => tail.slice(i * 64, i * 64 + 64));
  need(args.every((w) => /^0{24}[0-9a-f]{40}$/.test(w)), "ledger-initcode", "The ledger's constructor arguments are not canonical addresses.");
  const got = args.map((w) => "0x" + w.slice(24)), want = (artifact.constructorArgs || []).map(lower);
  need(want.length === 4 && got.every((a, i) => a === want[i]), "ledger-ctor-args", "The ledger's constructor arguments differ from the reviewed deployment.");
  return got;
}
function normLog(x){
  return { address: lower(x.address), topics: (x.topics || []).map(lower), data: lower(x.data), blockNumber: BigInt(x.blockNumber),
    blockHash: lower(x.blockHash), transactionHash: lower(x.transactionHash), logIndex: BigInt(x.logIndex) };
}
const word = (d, i) => d.slice(2 + i * 64, 2 + (i + 1) * 64);
function decodeDelegateSet(l){
  need(l.topics.length === 3 && /^0x0{24}[0-9a-f]{40}$/.test(l.topics[1]) && /^0x0{24}[0-9a-f]{40}$/.test(l.topics[2]) &&
    /^0x0{63}[01]$/.test(l.data), "malformed-event", "A DelegateSet event is malformed.");
  return { owner: "0x" + l.topics[1].slice(26), delegate: "0x" + l.topics[2].slice(26), allowed: l.data.endsWith("1") };
}
function decodeOpened(l){
  const d = l.data, len = d.length >= 2 + 64 * 6 ? Number(BigInt("0x" + word(d, 5))) : -1;
  need(l.topics.length === 3 && len >= 0 && len <= 4096 && BigInt("0x" + word(d, 4)) === 160n &&
    d.length === 2 + 64 * (6 + Math.ceil(len / 32)) && BigInt("0x" + word(d, 0)) < (1n << 64n) && BigInt("0x" + word(d, 2)) < 256n,
    "malformed-event", "A SessionOpened event is malformed.");
  return { sid: l.topics[1], keyHash: l.topics[2], expiresAt: BigInt("0x" + word(d, 0)), actions: BigInt("0x" + word(d, 1)), envs: Number(BigInt("0x" + word(d, 2))) };
}
const sortLogs = (a) => a.sort((x, y) => x.blockNumber < y.blockNumber ? -1 : x.blockNumber > y.blockNumber ? 1 : x.logIndex < y.logIndex ? -1 : x.logIndex > y.logIndex ? 1 : 0);
function joinLogs(old, tail){
  const seen = new Set(old.map((l) => l.blockHash + ":" + l.logIndex));
  for (const l of tail){ const k = l.blockHash + ":" + l.logIndex; need(!seen.has(k), "duplicate-log", "A log appeared twice across the cached history and the new tail."); seen.add(k); }
  return [...old, ...tail];
}

/* ---- reader plumbing -------------------------------------------------------------------------------------------- */
/** A census reader: the existing viem reader seam over the SDK's PublicClient for one RPC origin. */
export function censusReaders(sdk, chainId, rpcs = CENSUS_RPCS){
  const make = (o) => Object.assign(viemReader(sdk.chainClient(chainId, o.url)), { origin: new URL(o.url).origin, maxLogSpan: o.maxLogSpan });
  return { provenance: rpcs.provenance.map(make), history: rpcs.history.map(make) };
}
const METHODS = ["chainId", "latestBlock", "blockByNumber", "blockTxHashes", "codeHash", "read", "storageAt", "receipt", "tx", "logs"];
function metered(r, budget){
  let n = 0;
  const m = { origin: r.origin, maxLogSpan: r.maxLogSpan };
  for (const k of METHODS) m[k] = async (...a) => {
    if (++n > budget) throw inc("call-cap", "Read budget reached on " + r.origin + " (" + budget + " calls); the census is incomplete. Check again later.");
    if (typeof r[k] !== "function") throw inc("reader", r.origin + " cannot " + k + ".");
    try { return await r[k](...a); }
    catch(e){ if (e instanceof CensusIncomplete) throw e;
      throw inc("read", "Could not read " + k + " from " + r.origin + " (" + short(e) + "). Incomplete, not absence; check again later (rate limits are temporary)."); }
  };
  return m;
}
function pairOf(list, stage, budget){
  need(Array.isArray(list) && list.length === 2, "quorum", "The " + stage + " stage needs exactly two independent providers.");
  need(list[0].origin && list[1].origin && list[0].origin !== list[1].origin, "quorum", "The " + stage + " stage needs two distinct provider origins.");
  return list.map((r) => metered(r, budget));
}
async function agree(pair, stage, f){
  const vals = await Promise.all(pair.map(f));
  need(canon(vals[0]) === canon(vals[1]), "quorum-disagree", "The two " + stage + " providers (" + pair[0].origin + ", " + pair[1].origin + ") disagree; the census is incomplete.");
  return vals[0];
}
/** Both readers must see block `n` with exactly `hash` (bounded short wait for a lagging provider; no retry loop). */
async function pinBlock(pair, n, hash, code, what){
  await Promise.all(pair.map(async (r) => {
    let b = await r.blockByNumber(n);
    for (let i = 0; !b && i < BOUNDS.catchUpPolls; i++){ await new Promise((ok) => setTimeout(ok, BOUNDS.catchUpMs)); b = await r.blockByNumber(n); }
    need(b && lower(b.hash) === lower(hash), code, r.origin + " does not show " + what + " (block " + n + ") with the expected hash: stale, foreign or reorganized.");
  }));
}
async function scan(r, address, topics, from, to){
  if (from > to) return [];
  const span = BigInt(r.maxLogSpan || 0);
  need(span > 0n, "log-span", r.origin + " has no declared log range for history scans.");
  need((to - from + span) / span <= BigInt(BOUNDS.rangesPerStream), "range-cap", "History from block " + from + " needs more than " + BOUNDS.rangesPerStream + " log requests; incomplete.");
  const out = [], seen = new Set();
  for (let start = from; start <= to; start += span * 3n){
    const batch = [];
    for (let lo = start; lo <= to && lo < start + span * 3n; lo += span){
      const hi = min(lo + span - 1n, to);
      batch.push(r.logs({ address, topics, fromBlock: lo, toBlock: hi }).then(raw => ({lo, hi, raw})));
    }
    // At most three read-only requests per provider. Validate every range before advancing.
    for (const {lo, hi, raw} of await Promise.all(batch)){
    need(Array.isArray(raw) && raw.length < BOUNDS.logsPerResponse, "log-cap", r.origin + " returned a truncated or invalid log page for blocks " + lo + "-" + hi + ".");
    for (const a of raw){
      need(!a.removed, "reorg", "A log in blocks " + lo + "-" + hi + " was removed (reorg).");
      const x = normLog(a);
      need(x.address === lower(address) && x.topics[0] === topics[0] && x.blockNumber >= lo && x.blockNumber <= hi, "log-range", "A log outside the requested identity or range was returned.");
      topics.slice(1).forEach((t, i) => need(t == null || (Array.isArray(t) ? t.map(lower).includes(x.topics[i + 1]) : lower(t) === x.topics[i + 1]), "log-range", "A log did not match the topic filter."));
      const k = x.blockHash + ":" + x.logIndex;
      need(!seen.has(k), "duplicate-log", "A duplicate log was returned."); seen.add(k);
      out.push(x);
      need(out.length <= BOUNDS.eventsPerStream, "event-cap", "More than " + BOUNDS.eventsPerStream + " events in one stream; incomplete.");
    }
  }
  }
  return sortLogs(out);
}

/* ---- provenance facts (exact canonical creation witnesses + current pinned identity) ---------------------------- */
async function identityAt(r, b, vault, wallet){
  const [f, l, impl, lib, v] = await Promise.all([PINS.factory, PINS.ledger, CENSUS_PINS.implementation, CENSUS_PINS.library, vault].map((a) => r.codeHash(a, b)));
  need(f === PINS.factoryCodeHash && l === PINS.ledgerCodeHash && impl === CENSUS_PINS.implementationCodeHash && lib === CENSUS_PINS.libraryCodeHash,
    "code-identity", "Factory, ledger, vault implementation or library code is not the reviewed code.");
  need(v === cloneHash && v === PINS.vaultCodeHash, "code-identity", "The vault is not an exact clone of the reviewed implementation.");
  const [im, vf, vo, vb, isV, vFor, schema] = await Promise.all([r.read(PINS.factory, ABI.factory, "implementation", [], b), r.read(vault, ABI.vault, "factory", [], b),
    r.read(vault, ABI.vault, "owner", [], b), r.read(vault, ABI.vault, "book", [], b), r.read(PINS.factory, ABI.factory, "isVault", [vault], b),
    r.read(PINS.factory, ABI.factory, "vaultFor", [wallet], b), r.read(PINS.ledger, ABI.ledger, "deploymentsSchema", [], b)]);
  need(lower(im) === CENSUS_PINS.implementation && lower(vf) === PINS.factory && lower(vb) === PINS.book && isV === true && BigInt(schema) === PINS.ledgerSchema,
    "code-identity", "Factory/clone/book/ledger binding differs from the reviewed deployment.");
  need(lower(vo) === wallet && lower(vFor) === vault, "code-identity", "The factory does not bind this vault to this wallet.");
}
async function receiptWitness(r, h){
  const [tx, rc, blk] = await Promise.all([r.tx(h.txHash), r.receipt(h.txHash), r.blockTxHashes(h.block)]);
  need(tx && rc && blk, "birth-witness", "A creation witness transaction, receipt or block is not readable.");
  need(lower(tx.hash) === lower(h.txHash) && BigInt(tx.blockNumber) === BigInt(h.block) && lower(tx.blockHash) === lower(h.blockHash),
    "birth-witness", "The creation transaction is not in the witnessed canonical block.");
  need(okStatus(rc.status) && lower(rc.transactionHash) === lower(h.txHash) && BigInt(rc.blockNumber) === BigInt(h.block) && lower(rc.blockHash) === lower(h.blockHash),
    "birth-witness", "The creation receipt is not a successful receipt in the witnessed block.");
  need(lower(blk.hash) === lower(h.blockHash) && blk.transactions.map(lower).includes(lower(h.txHash)), "birth-witness", "The witnessed block does not contain the creation transaction.");
  return { tx, rc };
}
async function ledgerBirth(r, h, artifact){
  const { tx, rc } = await receiptWitness(r, h);
  need(tx.to == null && lower(rc.contractAddress) === PINS.ledger && createAddress(tx.from, tx.nonce) === PINS.ledger,
    "birth-witness", "The ledger was not created directly by the witnessed transaction (CREATE sender+nonce).");
  const ctorArgs = checkLedgerInitcode(tx.input, artifact);
  return { block: BigInt(h.block), blockHash: lower(h.blockHash), txHash: lower(h.txHash), creator: lower(tx.from), nonce: BigInt(tx.nonce), ctorArgs };
}
async function vaultBirth(r, h, owner, vault){
  const { rc } = await receiptWitness(r, h);
  const hits = (rc.logs || []).map(normLog).filter((l) => l.address === PINS.factory && l.topics[0] === TOPIC.VaultCreated &&
    l.topics[1] === padAddr(owner) && l.data === padAddr(vault) && (h.logIndex == null || l.logIndex === BigInt(h.logIndex)));
  need(hits.length === 1, "birth-witness", "The witnessed receipt has no exact factory VaultCreated(" + owner + ", " + vault + ").");
  return { block: BigInt(h.block), blockHash: lower(h.blockHash), txHash: lower(h.txHash), logIndex: hits[0].logIndex };
}
/** Archive getCode boundary for the pinned factory creation block (provenance pair). */
async function factoryBoundary(r){
  const b = CENSUS_PINS.factoryCreationBlock;
  const [pre, at] = await Promise.all([r.codeHash(PINS.factory, b - 1n), r.codeHash(PINS.factory, b)]);
  need(pre === EMPTY_CODE && at === PINS.factoryCodeHash, "factory-birth", "The factory creation boundary at block " + b + " is not confirmed.");
  return b;
}

/* ---- the census instance ---------------------------------------------------------------------------------------- */
/**
 * One shared census per (wallet, source vault) page. Cached data is immutable history only (logs up to a canonical
 * anchor); every qualify() re-pins the anchor, scans the tail to the snapshot block and re-reads all current state.
 * deps: { wallet, vault, sdk: { sessionVaultAbi, ACTIONS }, readers: { provenance: [r, r], history: [r, r] },
 *         loadLedgerArtifact: async () => artifact|null, hints?, nowSec? }
 */
export function createWalletCensus(deps){
  const wallet = lower(deps.wallet), vault = lower(deps.vault);
  const hints = deps.hints || BIRTH_HINTS;
  const sessionAbi = deps.sdk && deps.sdk.sessionVaultAbi, ACTIONS = (deps.sdk && deps.sdk.ACTIONS) || {};
  const nowSec = deps.nowSec || (() => Math.floor(Date.now() / 1000));
  let provenance = null, cache = null, queue = Promise.resolve();
  const stats = { provenanceBuilds: 0, historyBuilds: 0, vaultHistoryBuilds: 0, tails: 0 };
  const pairs = () => ({ P: pairOf(deps.readers && deps.readers.provenance, "provenance", BOUNDS.callsPerReaderPerCheck),
    H: pairOf(deps.readers && deps.readers.history, "history", BOUNDS.callsPerReaderPerCheck) });

  async function buildProvenance(P, snap){
    let artifact = null;
    try { artifact = deps.loadLedgerArtifact ? await deps.loadLedgerArtifact() : null; } catch(e){ artifact = null; }
    const at = BigInt(snap.block.number);
    await pinBlock(P, at, snap.block.hash, "census-snapshot", "the release snapshot");
    const vh = hints.vaults && hints.vaults[vault];
    const facts = await agree(P, "provenance", async (r) => {
      await identityAt(r, at, vault, wallet);
      return { ledger: await ledgerBirth(r, hints.ledger, artifact), vault: vh ? await vaultBirth(r, vh, wallet, vault) : null,
        factoryBirth: vh ? null : await factoryBoundary(r) };
    });
    stats.provenanceBuilds++;
    return facts;
  }
  /** Receipt-qualified birth of a supported vault: a validated hint, else one exact VaultCreated found by a two-provider
   *  scan from the factory's archive-verified creation block. Then the receipt is re-witnessed on the provenance pair. */
  async function birthOf(P, H, owner, v, to){
    let h = hints.vaults && hints.vaults[v];
    if (!h){
      const start = await agree(P, "provenance", factoryBoundary);
      const logs = await agree(H, "history", (r) => scan(r, PINS.factory, [TOPIC.VaultCreated, padAddr(owner)], start, to));
      const hits = logs.filter((l) => l.data === padAddr(v));
      need(hits.length === 1, "vault-birth", "No unique receipt-qualified creation event for vault " + v + "; its session history is incomplete.");
      h = { block: hits[0].blockNumber, blockHash: hits[0].blockHash, txHash: hits[0].transactionHash, logIndex: hits[0].logIndex };
    }
    const onP = await agree(P, "provenance", (r) => vaultBirth(r, h, owner, v));
    const onH = await agree(H, "history", (r) => vaultBirth(r, h, owner, v));
    need(canon(onP) === canon(onH), "birth-witness", "Provenance and history providers disagree on the birth of " + v + ".");
    return onH;
  }
  async function buildHistory(P, H, snap){
    const at = BigInt(snap.block.number);
    await pinBlock(H, at, snap.block.hash, "census-snapshot", "the release snapshot");
    // join: the history pair must show the same canonical creation witnesses the provenance pair verified
    const lb = await agree(H, "history", async (r) => { const { tx, rc } = await receiptWitness(r, hints.ledger);
      need(tx.to == null && lower(rc.contractAddress) === PINS.ledger, "birth-witness", "Ledger creation witness differs on the history providers.");
      return { block: BigInt(hints.ledger.block), blockHash: lower(hints.ledger.blockHash), txHash: lower(hints.ledger.txHash) }; });
    need(lb.blockHash === provenance.ledger.blockHash && lb.txHash === provenance.ledger.txHash, "birth-witness", "Ledger birth witnesses do not join.");
    const vb = provenance.vault ? await agree(H, "history", (r) => vaultBirth(r, hints.vaults[vault], wallet, vault)) : await birthOf(P, H, wallet, vault, at);
    if (provenance.vault) need(canon(vb) === canon(provenance.vault), "birth-witness", "Source vault birth witnesses do not join.");
    const delegateLogs = await agree(H, "history", (r) => scan(r, PINS.ledger, [TOPIC.DelegateSet, [padAddr(wallet), padAddr(vault)]], lb.block, at));
    const sessionLogs = await agree(H, "history", (r) => scan(r, vault, [TOPIC.SessionOpened], vb.block, at));
    stats.historyBuilds++;
    return { anchor: { number: at, hash: lower(snap.block.hash) }, ledgerBirth: lb, delegateLogs, vaults: new Map([[vault, { owner: wallet, birth: vb, logs: sessionLogs }]]) };
  }
  async function classify(r, d, b){
    const code = await r.codeHash(d, b);
    if (code === EMPTY_CODE) return { address: d, kind: "account-without-code" };
    for (const f of [PINS.factory, ...CENSUS_PINS.unsupportedFactories]){
      if (await r.read(f, ABI.factory, "isVault", [d], b) !== true) continue;
      if (f !== PINS.factory) return { address: d, kind: "vault-of-unqualified-factory", factory: f };
      const [vf, vo, vb] = await Promise.all(["factory", "owner", "book"].map((n) => r.read(d, ABI.vault, n, [], b)));
      if (code !== cloneHash || lower(vf) !== PINS.factory || lower(vb) !== PINS.book) return { address: d, kind: "clone-identity-mismatch" };
      return { address: d, kind: "supported-vault", owner: lower(vo) };
    }
    return { address: d, kind: "unknown-contract", codeHash: code };
  }
  async function sessionsOf(r, v, logs, b, ts){
    need(Array.isArray(sessionAbi), "abi", "The SDK's session vault ABI is unavailable; sessions cannot be read.");
    const epoch = BigInt(await r.read(v, ABI.vault, "epoch", [], b));
    const ids = new Map();
    for (const l of logs){ const e = decodeOpened(l); need(!ids.has(e.sid), "malformed-event", "Duplicate SessionOpened id " + e.sid + "."); ids.set(e.sid, { e, l }); }
    need(ids.size <= BOUNDS.sessionsPerVault, "session-cap", "Vault " + v + " has more than " + BOUNDS.sessionsPerVault + " sessions; incomplete.");
    const rows = [];
    for (const [sid, { e, l }] of ids){
      const res = await r.read(v, sessionAbi, "sessionOf", [sid], b);
      const [s, live, apps] = Array.isArray(res) ? res : [res.s, res.live, res.apps];
      need(s && lower(s.keyHash) === e.keyHash && BigInt(s.actions) === e.actions && Number(s.envs) === e.envs, "session-mismatch", "Session " + sid + " differs from its opening event.");
      const expected = Number(s.state) === 1 && BigInt(s.epoch) === epoch && ts <= BigInt(s.expiresAt);
      need(Boolean(live) === expected, "session-mismatch", "The vault's live flag for session " + sid + " disagrees with its state/epoch/expiry.");
      need(Array.isArray(apps) && apps.length <= BOUNDS.appsPerSession, "session-mismatch", "Session " + sid + " app scope is malformed.");
      rows.push({ sid, keyHash: e.keyHash, live: expected, envs: e.envs, actions: e.actions, state: Number(s.state), epoch: BigInt(s.epoch),
        expiresAt: BigInt(s.expiresAt), anyApp: Boolean(s.anyApp), apps: apps.map(lower), openedAt: { block: l.blockNumber, tx: l.transactionHash } });
    }
    return { epoch, rows };
  }
  /** Fresh state at the snapshot block from complete history; identical on both history providers. */
  async function stateAt(r, b, delegateLogs, vaults){
    const blk = await r.blockByNumber(b);
    const pairsMap = new Map();
    for (const l of delegateLogs){ const d = decodeDelegateSet(l), k = d.owner + ":" + d.delegate;
      const p = pairsMap.get(k) || { owner: d.owner, delegate: d.delegate, history: [] };
      p.history.push({ allowed: d.allowed, block: l.blockNumber, tx: l.transactionHash }); p.allowed = d.allowed; pairsMap.set(k, p); }
    need(pairsMap.size <= BOUNDS.delegates, "delegate-cap", "More than " + BOUNDS.delegates + " delegation pairs; incomplete.");
    const delegates = [...pairsMap.values()].sort((x, y) => (x.owner + x.delegate).localeCompare(y.owner + y.delegate));
    for (const p of delegates){
      const raw = await r.storageAt(PINS.ledger, delegateSlotOf(p.owner, p.delegate), b);
      need(typeof raw === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw), "delegate-mapping", "Delegation storage is unavailable or malformed.");
      const n = BigInt(raw);
      need(n === 0n || n === 1n, "delegate-mapping", "Delegation storage for " + p.delegate + " is not a boolean.");
      need((n === 1n) === p.allowed, "delegate-mapping", "Delegation event history and current ledger storage disagree for " + p.owner + " -> " + p.delegate + ".");
    }
    const raw0 = await r.storageAt(PINS.ledger, delegateSlotOf(wallet, vault), b);
    need(typeof raw0 === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw0), "delegate-mapping", "Wallet delegation storage is unavailable or malformed.");
    const n0 = BigInt(raw0);
    const delegationGranted = n0 === 1n;
    need((pairsMap.get(wallet + ":" + vault) || { allowed: false }).allowed === delegationGranted, "delegate-mapping", "Wallet -> vault delegation storage disagrees with its event history.");
    const classes = [];
    for (const p of delegates.filter((x) => x.owner === wallet && x.allowed && x.delegate !== vault)) classes.push(await classify(r, p.delegate, b));
    const sessions = {};
    for (const [v, h] of vaults) sessions[v] = await sessionsOf(r, v, h.logs, b, BigInt(blk.timestamp));
    return { delegates, delegationGranted, classes, sessions };
  }

  async function run(snap, extend){
    const { P, H } = pairs();
    need(lower(snap.identity.wallet) === wallet && lower(snap.identity.vault) === vault && snap.identity.chainId === PINS.chainId && lower(snap.identity.ledger) === PINS.ledger,
      "census-foreign", "The census belongs to another wallet, vault, chain or ledger.");
    need(Math.abs(nowSec() - Number(snap.block.timestamp)) <= MAX_BLOCK_AGE_SEC, "census-stale", "The release snapshot is too old for a census.");
    const at = BigInt(snap.block.number);
    if (!provenance) provenance = await buildProvenance(P, snap);
    if (!cache) cache = await buildHistory(P, H, snap);
    need(at >= cache.anchor.number, "census-stale", "The release snapshot is older than the census history anchor.");
    await pinBlock(H, at, snap.block.hash, "census-snapshot", "the release snapshot");
    try { await pinBlock(H, cache.anchor.number, cache.anchor.hash, "census-reorg", "the cached history anchor"); }
    catch(e){ cache = null; throw inc("census-reorg", "The cached history anchor is no longer canonical; it was discarded. Check again to rebuild it."); }
    // complete tails from anchor+1 through the snapshot block, then append to immutable history
    const from = cache.anchor.number + 1n;
    const tail = await agree(H, "history", async (r) => ({ d: await scan(r, PINS.ledger, [TOPIC.DelegateSet, [padAddr(wallet), padAddr(vault)]], from, at),
      v: await Promise.all([...cache.vaults.keys()].map((v) => scan(r, v, [TOPIC.SessionOpened], from, at))) }));
    const delegateLogs = joinLogs(cache.delegateLogs, tail.d);
    const vaults = new Map([...cache.vaults].map(([v, h], i) => [v, { ...h, logs: joinLogs(h.logs, tail.v[i]) }]));
    cache = { ...cache, anchor: { number: at, hash: lower(snap.block.hash) }, delegateLogs, vaults };
    stats.tails++;
    let state = await agree(H, "history", (r) => stateAt(r, at, delegateLogs, vaults));
    // newly discovered supported vaults reachable through wallet delegation need their own complete history
    const missing = state.classes.filter((c) => c.kind === "supported-vault" && !vaults.has(c.address));
    if (missing.length){
      need(extend, "new-vault", "A newly delegated vault (" + missing.map((c) => c.address).join(", ") + ") appeared; its session history has not been scanned. Check again before signing.");
      need(vaults.size + missing.length <= BOUNDS.vaults, "vault-cap", "Too many delegated vaults to scan; incomplete.");
      for (const c of missing){
        const birth = await birthOf(P, H, c.owner, c.address, at);
        const logs = await agree(H, "history", (r) => scan(r, c.address, [TOPIC.SessionOpened], birth.block, at));
        vaults.set(c.address, { owner: c.owner, birth, logs });
        stats.vaultHistoryBuilds++;
      }
      cache = { ...cache, vaults };
      state = await agree(H, "history", (r) => stateAt(r, at, delegateLogs, vaults));
    }
    return state;
  }

  const actionNames = (bits) => Object.entries(ACTIONS).filter(([, bit]) => (BigInt(bits) & (1n << BigInt(bit))) !== 0n).map(([n]) => n);
  /** `srcEnv` is the row's ACTUAL custody environment in the source vault at the snapshot (Held.env). */
  function assess(state, add, srcEnv){
    const narrowed = [], preserved = [];
    for (const c of state.classes){
      if (c.kind === "supported-vault") continue;
      add("unknown-delegate", "Your wallet delegates its ledger records to " + c.address + " (" + c.kind + "). Its authority over a wallet-owned app is not source-verified. Review it with your own delegation controls first.");
    }
    for (const p of state.delegates.filter((x) => x.owner === vault && x.allowed))
      add("source-delegate", "Your vault delegates its ledger records to " + p.delegate + ", which bypasses the vault's custody record; review it before moving.");
    for (const [v, s] of Object.entries(state.sessions)){
      const src = v === vault;
      for (const row of s.rows){
        if (!row.live) continue;
        const id = row.sid.slice(0, 10) + "…", acts = actionNames(row.actions).join(", ") || "none";
        if (row.envs & ~3) { add("session-env-unknown", "Live session " + id + " in " + v + " has an unknown environment mask " + row.envs + "."); continue; }
        if (!src){
          if (row.envs & 2) add("other-vault-gain", "Live session " + id + " of delegated vault " + v + " may act on your wallet's PRODUCTION records (" + acts + "); once wallet-held this app becomes reachable to it.");
          continue;
        }
        if (row.envs === 2) add("prod-only-gain", "Live session " + id + " is granted PRODUCTION only (" + acts + "): it cannot act on this STAGING app now, but a wallet-held app is PRODUCTION to sessions, and ledger funding is permissionless. Revoke or narrow it with your own controls first.");
        else if (row.envs === 1) narrowed.push("Session " + id + " (staging only) loses access to this app.");
        else if (row.envs === 3) (state.delegationGranted ? preserved : narrowed).push("Session " + id + " (staging+production; " + acts + ") " +
          (state.delegationGranted ? "keeps its common actions through your wallet's delegation to this vault, but loses setAppRef/setConfig (PRODUCTION never allows them)."
            : "loses delegated access: your wallet has not delegated to this vault. Permissionless funding is not covered by this statement."));
      }
    }
    return { narrowed, preserved };
  }

  async function qualify(snap, { extend = false } = {}){
    const blockers = [];
    const add = (code, text) => blockers.push({ code, text });
    let state = null, view = { narrowed: [], preserved: [] };
    try { state = await run(snap, extend); view = assess(state, add); }
    catch(e){ add(e instanceof CensusIncomplete ? e.code : "census-read", e instanceof CensusIncomplete ? e.message : "The authority census could not complete (" + short(e) + "); incomplete, not absence."); }
    const complete = !!state && !blockers.some((b) => !/^(unknown-delegate|source-delegate|other-vault-gain|prod-only-gain|session-env-unknown)$/.test(b.code));
    const policy = state ? { d: state.delegates.map((p) => [p.owner, p.delegate, p.allowed]), c: state.classes,
      s: Object.entries(state.sessions).map(([v, s]) => [v, s.epoch, s.rows.map((x) => [x.sid, x.live, x.envs, x.actions, x.expiresAt, x.state, x.anyApp, x.apps])]) } : null;
    const result = Object.freeze({
      complete, census: this_, delegationGranted: state ? state.delegationGranted : null,
      binding: Object.freeze({ chainId: PINS.chainId, ledger: PINS.ledger, vault, wallet, block: Object.freeze({ number: String(snap.block.number), hash: lower(snap.block.hash) }) }),
      checkpoint: cache ? { number: cache.anchor.number.toString(), hash: cache.anchor.hash } : null,
      policyHash: policy ? keccak256Utf8(canon(policy)) : null,
      blockers: Object.freeze(blockers), narrowed: Object.freeze(view.narrowed), preserved: Object.freeze(view.preserved), limits: LIMITS,
      counts: state ? { delegations: state.delegates.length, sessions: Object.values(state.sessions).reduce((n, s) => n + s.rows.length, 0),
        liveSessions: Object.values(state.sessions).reduce((n, s) => n + s.rows.filter((x) => x.live).length, 0), vaults: Object.keys(state.sessions).length } : null,
    });
    ISSUED.add(result);
    return result;
  }
  const this_ = {
    wallet, vault, stats,
    /** Serialized: concurrent rows share one history build; cached history is never cached permission. */
    qualify(snap, opts){ const p = queue.then(() => qualify(snap, opts)); queue = p.catch(() => {}); return p; },
  };
  INSTANCES.add(this_);
  return this_;
}
export const isWalletCensus = (c) => !!c && INSTANCES.has(c);

/* ---- the release gate with census authority ---------------------------------------------------------------------- */
/** chain.evaluate plus the census verdict, accepted only if this module issued it for exactly this snapshot. */
export function evaluateRelease(snap, result, opts = {}){
  const id = snap.identity;
  let authority;
  if (!result || !ISSUED.has(result)) authority = { blockers: [{ code: "census-forged", text: "No census issued by this page for this check; nothing can move." }] };
  else {
    const b = result.binding;
    if (b.chainId !== id.chainId || b.ledger !== lower(id.ledger) || b.vault !== lower(id.vault) || b.wallet !== lower(id.wallet) ||
        b.block.number !== String(snap.block.number) || b.block.hash !== lower(snap.block.hash))
      authority = { blockers: [{ code: "census-stale", text: "The authority census was taken for a different wallet, vault or block; check again." }] };
    else {
      const blockers = [...result.blockers];
      if (!result.complete && !blockers.length) blockers.push({ code: "census-incomplete", text: "The authority census is incomplete." });
      if (result.complete && result.delegationGranted !== snap.delegationGranted)
        blockers.push({ code: "delegate-mapping", text: "The census and the release snapshot disagree about your wallet's delegation to this vault." });
      authority = { blockers, census: { checkpoint: result.checkpoint, counts: result.counts, narrowed: result.narrowed, preserved: result.preserved, limits: result.limits } };
    }
  }
  const ev = evaluate(snap, { ...opts, authority });
  return { ...ev, censusPolicy: result && ISSUED.has(result) ? result.policyHash : null };
}
