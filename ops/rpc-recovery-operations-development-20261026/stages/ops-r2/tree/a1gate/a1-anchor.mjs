// A1: the Base anchor, read from an AUTHENTICATED Ethereum finalized state (finality-stage/l1-anchor-a1, README.md).
// Pure ES module, no imports: keccak256 (Uint8Array -> Uint8Array) and the L1 headerHash function are injected.
//
// Trust classes recorded per value (only the first two may decide anything):
//   "helios-call"  eth_call/getProof answered by the pinned Helios ethereum client: EVM executed over storage/account
//                  proofs it verified against the state root of a block its BEACON LIGHT CLIENT accepted as finalized
//                  (weak-subjectivity checkpoint + sync-committee signatures; core/src/client/node.rs:290-330, 437-455).
//   "mpt-proof"    an account/storage value THIS module verified (Merkle-Patricia proof) against the stateRoot of the
//                  Helios-finalized header, whose keccak(RLP) WE recomputed to equal the Helios block hash.
//   "plain-rpc"    anything else (our own reth/KVM endpoint answering directly): observation only, NEVER authority.

export class A1Error extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new A1Error(code, message); };
export const toHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function fromHex(h, n) {
  const s = String(h);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(s)) fail("bad_hex", `not even-length hex: ${s.slice(0, 20)}`);
  const b = Uint8Array.from(s.slice(2).match(/../g) || [], (x) => parseInt(x, 16));
  if (n !== undefined && b.length !== n) fail("bad_hex", `expected ${n} bytes, got ${b.length}`);
  return b;
}
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- RLP decode (strict: canonical lengths, no trailing bytes) ------------------------------------------------------
export function rlpDecode(bytes) {
  const [item, end] = decodeAt(bytes, 0);
  if (end !== bytes.length) fail("bad_rlp", "trailing bytes");
  return item;
}
function decodeAt(b, i) {
  if (i >= b.length) fail("bad_rlp", "truncated");
  const p = b[i];
  const len = (o, n) => { if (o + n > b.length) fail("bad_rlp", "truncated length"); let v = 0; for (let k = 0; k < n; k++) v = v * 256 + b[o + k]; if (n && b[o] === 0) fail("bad_rlp", "non-canonical length"); return v; };
  if (p < 0x80) return [b.slice(i, i + 1), i + 1];
  if (p < 0xb8) { const n = p - 0x80, e = i + 1 + n; if (e > b.length) fail("bad_rlp", "truncated string"); if (n === 1 && b[i + 1] < 0x80) fail("bad_rlp", "non-canonical byte"); return [b.slice(i + 1, e), e]; }
  if (p < 0xc0) { const ll = p - 0xb7, n = len(i + 1, ll), s = i + 1 + ll; if (n < 56) fail("bad_rlp", "non-canonical long string"); if (s + n > b.length) fail("bad_rlp", "truncated string"); return [b.slice(s, s + n), s + n]; }
  let s, n;
  if (p < 0xf8) { n = p - 0xc0; s = i + 1; } else { const ll = p - 0xf7; n = len(i + 1, ll); s = i + 1 + ll; if (n < 56) fail("bad_rlp", "non-canonical long list"); }
  const e = s + n; if (e > b.length) fail("bad_rlp", "truncated list");
  const out = []; let k = s;
  while (k < e) { const [it, nk] = decodeAt(b, k); out.push(it); k = nk; }
  if (k !== e) fail("bad_rlp", "list length mismatch");
  return [out, e];
}
const toNibbles = (b) => { const n = []; for (const x of b) n.push(x >> 4, x & 15); return n; };

// ---- Merkle-Patricia proof (eth_getProof): value bytes, or null when the proof shows the key ABSENT ---------------
export function verifyMptProof(rootHex, keyBytes, proofHex, keccak) {
  const root = fromHex(rootHex, 32);
  let path = toNibbles(keyBytes), i = 0;
  let want = { hash: root };                       // next expected node: by hash, or an inline (embedded) node
  for (;;) {
    let node;
    if (want.hash) {
      if (i >= proofHex.length) fail("proof_short", "proof ends before the key is resolved");
      const raw = fromHex(proofHex[i++]);
      if (!eq(keccak(raw), want.hash)) fail("proof_hash", `proof node ${i - 1} does not hash to its reference`);
      node = rlpDecode(raw);
    } else node = want.inline;
    if (!Array.isArray(node)) fail("proof_node", "node is not a list");
    let next;
    if (node.length === 17) {
      if (path.length === 0) { next = { value: node[16] }; }
      else { const c = node[path[0]]; path = path.slice(1); next = c.length === 0 && !Array.isArray(c) ? { absent: true } : ref(c); }
    } else if (node.length === 2) {
      const enc = toNibbles(node[0]); const flag = enc[0]; if (flag > 3) fail("proof_node", "bad hex-prefix flag");
      const key = enc.slice(flag & 1 ? 1 : 2), leaf = (flag & 2) !== 0;
      const matches = key.length <= path.length && key.every((x, k) => x === path[k]);
      if (leaf) next = matches && key.length === path.length ? { value: node[1] } : { absent: true };
      else if (!matches) next = { absent: true };
      else { path = path.slice(key.length); next = ref(node[1]); }
    } else fail("proof_node", `node has ${node.length} items`);
    if (next.value !== undefined || next.absent) {
      if (i !== proofHex.length) fail("proof_extra", "proof has nodes past the resolved key");
      if (next.absent || next.value.length === 0) return null;
      return next.value;
    }
    want = next;
  }
  function ref(c) {
    if (Array.isArray(c)) return { inline: c };    // child shorter than 32 bytes is embedded in its parent
    if (c.length !== 32) fail("proof_node", "child reference is neither a hash nor an inline node");
    return { hash: c };
  }
}
const big = (b) => b.length === 0 ? 0n : BigInt(toHex(b));
export function verifyAccount(stateRoot, address, accountProof, keccak) {
  const v = verifyMptProof(stateRoot, keccak(fromHex(address, 20)), accountProof, keccak);
  if (v === null) return { absent: true };
  const f = rlpDecode(v);
  if (!Array.isArray(f) || f.length !== 4 || f[2].length !== 32 || f[3].length !== 32) fail("bad_account", "account value is not [nonce,balance,storageRoot,codeHash]");
  return { nonce: big(f[0]), balance: big(f[1]), storageRoot: toHex(f[2]), codeHash: toHex(f[3]) };
}
export function verifyStorage(storageRoot, slotHex, proof, keccak) {
  const v = verifyMptProof(storageRoot, keccak(fromHex(slotHex, 32)), proof, keccak);
  if (v === null) return 0n;
  const s = rlpDecode(v);
  if (Array.isArray(s) || s.length > 32 || (s.length && s[0] === 0)) fail("bad_storage", "storage value is not a canonical uint");
  return big(s);
}
const qty = (h) => BigInt(h);
// storage keys arrive as 32-byte hex or as quantities ("0x1"): normalize to the 32-byte slot
const slot32 = (h) => {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(String(h))) fail("bad_slot", `bad storage key ${String(h).slice(0, 20)}`);
  return "0x" + BigInt(h).toString(16).padStart(64, "0");
};
/** Verify an eth_getProof JSON answer against stateRoot; every JSON field must equal what the proofs show. */
export function checkProofResponse(stateRoot, r, keccak) {
  const acct = verifyAccount(stateRoot, r.address, r.accountProof, keccak);
  if (acct.absent) fail("account_absent", `${r.address} has no account at this state`);
  if (qty(r.nonce) !== acct.nonce || qty(r.balance) !== acct.balance || String(r.codeHash).toLowerCase() !== acct.codeHash || String(r.storageHash).toLowerCase() !== acct.storageRoot)
    fail("proof_json_mismatch", `eth_getProof JSON fields for ${r.address} differ from the proven account`);
  const storage = {};
  for (const sp of r.storageProof || []) {
    const v = verifyStorage(acct.storageRoot, slot32(sp.key), sp.proof, keccak);
    if (qty(sp.value) !== v) fail("proof_json_mismatch", `storage ${sp.key} JSON value differs from the proven value`);
    storage[slot32(sp.key)] = v;
  }
  return { ...acct, storage };
}

// ---- ABI (static words only; strict) --------------------------------------------------------------------------------
export const selector = (sig, keccak) => toHex(keccak(new TextEncoder().encode(sig)).slice(0, 4));
export function callData(sig, args, keccak) {
  return selector(sig, keccak) + args.map((a) => {
    const h = /^0x[0-9a-fA-F]{40}$/.test(a) ? a.slice(2).toLowerCase() : BigInt(a).toString(16);
    if (h.length > 64) fail("bad_arg", "argument exceeds 32 bytes");
    return h.padStart(64, "0");
  }).join("");
}
function words(ret, n) {
  const b = fromHex(ret);
  if (b.length !== 32 * n) fail("bad_return", `expected ${n} ABI word(s), got ${b.length} bytes`);
  return Array.from({ length: n }, (_, k) => b.slice(32 * k, 32 * k + 32));
}
export const abi = {
  address: (ret) => { const [w] = words(ret, 1); if (w.slice(0, 12).some((x) => x)) fail("bad_return", "address word has dirty upper bytes"); return toHex(w.slice(12)); },
  bool: (ret) => { const [w] = words(ret, 1); const v = big(w); if (v > 1n) fail("bad_return", "bool word is not 0/1"); return v === 1n; },
  uint: (ret, bits = 256) => { const [w] = words(ret, 1); const v = big(w); if (v >= 1n << BigInt(bits)) fail("bad_return", `value exceeds uint${bits}`); return v; },
  bytes32: (ret) => toHex(words(ret, 1)[0]),
  rootAndNumber: (ret) => { const [a, b] = words(ret, 2); return { root: toHex(a), l2SequenceNumber: big(b) }; },
};

// ---- the A1 read plan (signatures from base v1.5.1 bindings; the portal getter is a CONFIG input) -------------------
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
export const ASR_CALLS = {        // crates/proof/contracts/src/anchor_state_registry.rs:13-49
  anchorRoot: ["getAnchorRoot()", "rootAndNumber"], anchorGame: ["anchorGame()", "address"],
  respectedGameType: ["respectedGameType()", "uint32"], paused: ["paused()", "bool"],
  disputeGameFactory: ["disputeGameFactory()", "address"],
};
export const ASR_GAME_CALLS = {   // same file: per-game eligibility (argument = the anchor game)
  isGameFinalized: "isGameFinalized(address)", isGameRespected: "isGameRespected(address)",
  isGameBlacklisted: "isGameBlacklisted(address)", isGameRetired: "isGameRetired(address)",
};
export const GAME_CALLS = {       // crates/proof/contracts/src/aggregate_verifier.rs:147-277
  status: ["status()", "uint8"], rootClaim: ["rootClaim()", "bytes32"], l2SequenceNumber: ["l2SequenceNumber()", "uint"],
  type: ["gameType()", "uint32"], anchorStateRegistry: ["anchorStateRegistry()", "address"],   // recorded as game<Name>
};
const decode = (kind, ret) => kind === "uint8" ? Number(abi.uint(ret, 8)) : kind === "uint32" ? Number(abi.uint(ret, 32)) : abi[kind](ret);
const lc = (a) => String(a).toLowerCase();
const ADDR = /^0x[0-9a-f]{40}$/;

// L1 finality normally trails the wall clock by ~13-20 min; a finalized header older than this means a stalled light
// client or a withheld update, and A1 refuses rather than read an old state. Future skew allowance: 15 s.
export const DEFAULT_MAX_FINALIZED_AGE_SEC = 1800;
export const MAX_FUTURE_SKEW_SEC = 15;
export function validateConfig(cfg) {
  const c = { ...cfg, portal: lc(cfg.portal), asr: lc(cfg.asr) };
  if (!ADDR.test(c.portal) || !ADDR.test(c.asr)) fail("bad_config", "portal and asr must be explicit 20-byte addresses (config-bound)");
  if (typeof c.portalAsrGetter !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(c.portalAsrGetter)) fail("bad_config", "portalAsrGetter (e.g. a no-argument getter signature) must be configured explicitly");
  if (c.expectedChainId !== 1) fail("bad_config", "A1 reads Ethereum mainnet (chain id 1)");
  if (c.pinBy !== undefined && c.pinBy !== "hash" && c.pinBy !== "finalized-tag") fail("bad_config", "pinBy is hash | finalized-tag");
  c.maxFinalizedAgeSec = c.maxFinalizedAgeSec ?? DEFAULT_MAX_FINALIZED_AGE_SEC;
  if (!Number.isInteger(c.maxFinalizedAgeSec) || c.maxFinalizedAgeSec < 60 || c.maxFinalizedAgeSec > 7200)
    fail("bad_config", "maxFinalizedAgeSec must be an integer in 60..7200");
  return c;
}

/** Policy over authenticated reads. Every input value must carry source helios-call or mpt-proof. -> verdict */
export function evaluateA1(cfg, r) {
  const need = (name) => { const v = r[name]; if (!v || (v.source !== "helios-call" && v.source !== "mpt-proof")) fail("unauthenticated", `${name} is not an authenticated read (source ${v?.source ?? "missing"})`); return v.value; };
  const asrFromPortal = lc(need("portalAsr"));
  if (asrFromPortal !== cfg.asr) fail("asr_mismatch", `the portal's ASR is ${asrFromPortal}, the config binds ${cfg.asr}`);
  if (need("paused")) fail("asr_paused", "AnchorStateRegistry is paused");
  const anchor = need("anchorRoot"), game = lc(need("anchorGame"));
  if (!ADDR.test(game) || /^0x0+$/.test(game)) fail("no_anchor_game", "anchorGame is zero (starting anchor): no finalized game backs the anchor");
  if (!need("isGameRespected")) fail("game_not_respected", "anchor game is not respected");
  if (!need("isGameFinalized")) fail("game_not_finalized", "anchor game is not finalized");
  if (need("isGameBlacklisted")) fail("game_blacklisted", "anchor game is blacklisted");
  if (need("isGameRetired")) fail("game_retired", "anchor game is retired");
  if (need("gameStatus") !== 2) fail("game_not_defender_wins", `game status ${need("gameStatus")} != 2 (DEFENDER_WINS)`);
  if (lc(need("gameRootClaim")) !== lc(anchor.root)) fail("root_mismatch", "game rootClaim != ASR anchor root");
  if (need("gameL2SequenceNumber") !== anchor.l2SequenceNumber) fail("number_mismatch", "game l2SequenceNumber != ASR anchor number");
  if (lc(need("gameAnchorStateRegistry")) !== cfg.asr) fail("game_asr_mismatch", "the game names a different AnchorStateRegistry");
  if (need("gameType") !== need("respectedGameType")) fail("game_type_mismatch", "game type != respected game type");
  for (const a of [cfg.portal, cfg.asr, game]) {
    const p = need(`account:${a}`);
    if (p.absent || p.codeHash === "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") fail("no_code", `${a} has no contract code at the finalized state`);
  }
  return { verdict: "A1-authenticated", N: anchor.l2SequenceNumber.toString(), outputRoot: lc(anchor.root), game, asr: cfg.asr,
           respectedGameType: need("respectedGameType"), l1: need("l1Finalized") };
}

/** Run A1 against Helios (verifier) and our own EL (UNTRUSTED proof source). io.helios/io.el: (method, params) => result. */
export async function runA1(cfg0, io, { keccak, headerHash, now = () => Date.now() }) {
  const cfg = validateConfig(cfg0);
  const r = {}, observations = {};
  if (BigInt(await io.helios("eth_chainId", [])) !== 1n) fail("wrong_chain", "Helios is not on chain 1");
  const fin = await io.helios("eth_getBlockByNumber", ["finalized", false]);
  if (!fin || !/^0x[0-9a-f]{64}$/.test(lc(fin.hash))) fail("no_finality", "Helios has no finalized block");
  const at = { blockHash: lc(fin.hash) };
  // Helios answers hash-pinned reads only for blocks in its cache; "finalized-tag" reads the moving tag instead and
  // REFUSES unless the finalized hash is unchanged after the last read (all reads then came from that one block)
  const callAt = cfg.pinBy === "finalized-tag" ? "finalized" : at;
  // the header comes from the untrusted EL; it is accepted only because WE recompute its hash to the Helios hash
  const hdr = await io.el("eth_getBlockByHash", [at.blockHash, false]);
  if (!hdr || headerHash(hdr, keccak) !== at.blockHash) fail("header_mismatch", "EL header does not hash to the Helios-finalized hash");
  observations.elHeaderNumber = hdr.number;
  // the hash binds the header's number and timestamp; Helios's own number (and timestamp, if given) must agree with it
  const number = Number(qty(hdr.number)), ts = Number(qty(hdr.timestamp));
  if (Number(qty(fin.number)) !== number) fail("finalized_number_mismatch", `Helios finalized number ${Number(qty(fin.number))} != header number ${number}`);
  if (fin.timestamp !== undefined && Number(qty(fin.timestamp)) !== ts) fail("finalized_timestamp_mismatch", "Helios finalized timestamp != header timestamp");
  const t = Math.floor(now() / 1000);
  if (ts > t + MAX_FUTURE_SKEW_SEC) fail("finalized_future", `finalized header is ${ts - t} s in the future`);
  if (t - ts > cfg.maxFinalizedAgeSec) fail("finalized_stale", `finalized header is ${t - ts} s old (max ${cfg.maxFinalizedAgeSec})`);
  r.l1Finalized = { source: "helios-call", value: { number, hash: at.blockHash, stateRoot: lc(hdr.stateRoot), timestamp: ts, ageSec: t - ts } };
  const call = async (to, sig, args = []) => {
    try { return await io.helios("eth_call", [{ to, data: callData(sig, args, keccak) }, callAt]); }
    catch (e) { fail("helios_call_failed", `${sig} on ${to}: ${String(e?.message || e).slice(0, 160)}`); }
  };
  const set = (name, value) => { r[name] = { source: "helios-call", value }; return value; };
  set("portalAsr", abi.address(await call(cfg.portal, cfg.portalAsrGetter)));
  for (const [name, [sig, kind]] of Object.entries(ASR_CALLS)) set(name, decode(kind, await call(cfg.asr, sig)));
  const game = lc(r.anchorGame.value);
  for (const [name, sig] of Object.entries(ASR_GAME_CALLS)) set(name, abi.bool(await call(cfg.asr, sig, [game])));
  for (const [name, [sig, kind]] of Object.entries(GAME_CALLS)) set("game" + name[0].toUpperCase() + name.slice(1), decode(kind, await call(game, sig)));
  // independent layer: account (and EIP-1967 slot) proofs from the UNTRUSTED EL, verified HERE against the header root
  const pins = {};
  const slots = (cfg.proofSlots || [EIP1967_IMPLEMENTATION_SLOT, EIP1967_ADMIN_SLOT]).map(slot32);
  for (const a of [...new Set([cfg.portal, cfg.asr, game])]) {
    const pr = await io.el("eth_getProof", [a, slots, at]);
    if (lc(pr?.address) !== a) fail("proof_address", `eth_getProof answered for ${pr?.address}, asked ${a}`);
    const got = (pr.storageProof || []).map((sp) => slot32(sp.key));
    if (got.length !== slots.length || got.some((k, i) => k !== slots[i])) fail("proof_slots", `eth_getProof for ${a} did not prove exactly the requested slots`);
    const v = checkProofResponse(r.l1Finalized.value.stateRoot, pr, keccak);
    r[`account:${a}`] = { source: "mpt-proof", value: v };
    const word = (k) => "0x" + v.storage[k].toString(16).padStart(64, "0");
    pins[a] = { codeHash: v.codeHash, storageRoot: v.storageRoot, slots: Object.fromEntries(slots.map((k) => [k, word(k)])),
                ...(slots.includes(EIP1967_IMPLEMENTATION_SLOT) ? { eip1967Implementation: "0x" + word(EIP1967_IMPLEMENTATION_SLOT).slice(26) } : {}),
                ...(slots.includes(EIP1967_ADMIN_SLOT) ? { eip1967Admin: "0x" + word(EIP1967_ADMIN_SLOT).slice(26) } : {}) };
  }
  if (cfg.pinBy === "finalized-tag") {
    const after = await io.helios("eth_getBlockByNumber", ["finalized", false]);
    if (lc(after?.hash) !== at.blockHash) fail("finality_moved", "Helios finalized block changed during A1; rerun");
  }
  const verdict = evaluateA1(cfg, r);
  const candidates = (cfg.asrCandidates || []).map((c) => ({ ...c, authenticatedMatch: lc(c.address) === r.portalAsr.value }));
  return { ...verdict, pins, asrCandidates: candidates, reads: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.source])), observations };
}
