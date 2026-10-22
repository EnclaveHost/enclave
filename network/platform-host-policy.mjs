// Platform host-admission policy: the administrator's signed, ANCHORED decision about which hosts may serve - the
// platform-wide host ban (and optional exclusive admission) that the Nan relay's TRUSTED_OPERATORS / attach allowlists
// enforced, without a server and without a new contract. Service refusal only: the deployed ledger has no per-host admin
// ban, so a banned host can still CLAIM leases on chain; these gates refuse it traffic, custody secrets, routes,
// management and (in a measured guest) service. Existing admin rights and contracts are unchanged.
//
// AUTHORITY (core v2): EnclaveAddressBook.owner() at the SAME agreed fresh block as the anchor and the host facts of every
// acceptance AND every decision. An EOA owner signs EIP-712; a contract owner answers ERC-1271 at THAT block. A two-step
// book handoff or a withdrawn ERC-1271 approval stops admission at once; the current owner re-signs the same document
// (same digest - no anchor write) to restore it. Mirrors confer nothing.
//
// ANCHOR (full 32 bytes, two existing address-valued book keys, written together with the existing setMany):
//   book.addr("hostPolicyDigestHi") = 0x00000000 ‖ digest[0..16)     book.addr("hostPolicyDigestLo") = 0x00000000 ‖ digest[16..32)
//   Each value must have its top 4 bytes zero. Both are read in ONE agreed snapshot. Both zero = unanchored; exactly one
//   zero, or bad padding = torn/malformed -> refuse. A non-zero anchor names exactly one policy (its EIP-712 digest);
//   nothing else is accepted, so a mirror cannot hand a cold client a withheld older (still-signed) policy.
//   Unanchored (signed-only) operation has a TTL but cannot prove the latest revocation to a new client; the enforcing
//   gate refuses it unless explicitly configured `allowUnanchored` (test/transition use only).
//
// DOCUMENT (canonical JSON):
//   { format: "enclave-platform-host-policy/v1", chainId: 8453, book, registry, hostOwnership, sequence, issuedAt,
//     expiresAt, maxStaleSec, previousDigest, mode: "denylist" | "allowlist", deny: [{kind, value, reason}], admit: [{kind, value}] }
//   kind: registryId | operator | owner (ACCEPTED host wallet on `hostOwnership`, read at the agreed block, never self-
//   reported) | chipId | endpoint. Denials always win. Allowlist mode admits only listed hosts (the relay's former model).
//
// EXPIRY MODES: expiresAt = 0 is the ANCHORED, NON-EXPIRING mode (maxStaleSec 0): valid exactly while its full digest is the
// anchor in a fresh majority-agreed book snapshot - the anchor supplies revocation and version freshness, so the admin
// signs only on actual policy changes, never on a renewal schedule. Such a document is refused whenever it is not the
// current anchor (unanchored, torn, another digest). expiresAt > 0 is an intentionally TIME-LIMITED policy (and the only
// kind an explicitly unanchored gate may use): it expires even while anchored.
// REPLAY/ROLLBACK: a persisted high-water {sequence, digest}; lower sequence refused; same sequence/different digest is
// equivocation (refused, reported). A persisted record that fails re-verification is discarded and reported; the anchor
// then decides. EXPIRY never lifts a ban; a stale policy refuses NEW hosts (see judgeHost).
import { keccak256, toHex, hashTypedData, recoverTypedDataAddress, stringToHex, encodeFunctionData } from "viem";

export const POLICY_FORMAT = "enclave-platform-host-policy/v1";
export const ANCHOR_KEYS = Object.freeze({ hi: stringToHex("hostPolicyDigestHi", { size: 32 }), lo: stringToHex("hostPolicyDigestLo", { size: 32 }) });
export const MAX_ENTRIES = 4096, MAX_VALIDITY_SEC = 30 * 86400, MAX_STALE_SEC = 14 * 86400;
const KINDS = { registryId: /^0x[0-9a-f]{64}$/, chipId: /^0x[0-9a-f]{64}$/, operator: /^0x[0-9a-f]{40}$/, owner: /^0x[0-9a-f]{40}$/,
                endpoint: /^https:\/\/[a-z0-9.-]{1,180}(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~/-]{0,200})?$/ };
const ADDR = /^0x[0-9a-f]{40}$/, H32 = /^0x[0-9a-f]{64}$/, ZERO = "0x" + "00".repeat(20);
const lc = (s) => String(s).toLowerCase();
const uint = (n) => Number.isSafeInteger(n) && n >= 0;
const err = (code, message) => Object.assign(new Error(message), { code });
const canonical = (v) => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v);
export const canonicalPolicy = (p) => canonical(validatePolicy(p));

// ---------------------------------------------------------------- format
const FIELDS = ["format", "chainId", "book", "registry", "hostOwnership", "sequence", "issuedAt", "expiresAt", "maxStaleSec", "previousDigest", "mode", "deny", "admit"];
export function validatePolicy(p) {
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((k) => !FIELDS.includes(k)) || FIELDS.some((k) => !(k in p))) throw err("bad_policy", "policy: exact fields required");
  if (p.format !== POLICY_FORMAT || p.chainId !== 8453 || !ADDR.test(p.book) || !ADDR.test(p.registry) || !ADDR.test(p.hostOwnership)) throw err("bad_policy", "policy: format, chain, book, registry or ownership binding");
  if (!uint(p.sequence) || p.sequence < 1 || !uint(p.issuedAt) || !uint(p.expiresAt)) throw err("bad_policy", "policy: sequence or validity window");
  if (p.expiresAt === 0) { if (p.maxStaleSec !== 0) throw err("bad_policy", "policy: an anchored non-expiring policy has maxStaleSec 0"); }
  else if (p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > MAX_VALIDITY_SEC) throw err("bad_policy", "policy: sequence or validity window");
  if (!uint(p.maxStaleSec) || p.maxStaleSec > MAX_STALE_SEC) throw err("bad_policy", "policy: maxStaleSec");
  if (!H32.test(p.previousDigest)) throw err("bad_policy", "policy: previousDigest");
  if (!["denylist", "allowlist"].includes(p.mode)) throw err("bad_policy", "policy: mode");
  if (!Array.isArray(p.deny) || !Array.isArray(p.admit) || p.deny.length + p.admit.length > MAX_ENTRIES) throw err("bad_policy", "policy: entries");
  if (p.mode === "denylist" && p.admit.length) throw err("bad_policy", "policy: a denylist admits nothing explicitly");
  const seen = new Set();
  for (const [list, withReason] of [[p.deny, true], [p.admit, false]]) for (const e of list) {
    const ek = withReason ? ["kind", "value", "reason"] : ["kind", "value"];
    if (!e || typeof e !== "object" || Object.keys(e).length !== ek.length || ek.some((k) => !(k in e)) || !KINDS[e.kind] || !KINDS[e.kind].test(e.value)) throw err("bad_policy", "policy: entry");
    if (withReason && (typeof e.reason !== "string" || e.reason.length > 280)) throw err("bad_policy", "policy: reason");
    const id = (withReason ? "d:" : "a:") + e.kind + ":" + e.value;
    if (seen.has(id)) throw err("bad_policy", "policy: duplicate entry");
    seen.add(id);
  }
  return p;
}
export const contentHash = (p) => keccak256(toHex(canonical({ registry: p.registry, hostOwnership: p.hostOwnership, mode: p.mode, deny: p.deny, admit: p.admit, maxStaleSec: p.maxStaleSec })));
export const policyTypedData = (p) => ({
  domain: { name: "EnclavePlatformHostPolicy", version: "1", chainId: p.chainId, verifyingContract: p.book },
  types: { HostPolicy: [{ name: "sequence", type: "uint64" }, { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" },
                        { name: "previousDigest", type: "bytes32" }, { name: "contentHash", type: "bytes32" }] },
  primaryType: "HostPolicy",
  message: { sequence: BigInt(p.sequence), issuedAt: BigInt(p.issuedAt), expiresAt: BigInt(p.expiresAt), previousDigest: p.previousDigest, contentHash: contentHash(p) },
});
export const policyDigest = (p) => hashTypedData(policyTypedData(validatePolicy(p)));

// ---------------------------------------------------------------- anchor encoding
export function encodeAnchor(digest) {
  if (!H32.test(lc(digest))) throw err("bad_anchor", "anchor: a 32-byte digest is required");
  const h = lc(digest).slice(2);
  return { hi: "0x00000000" + h.slice(0, 32), lo: "0x00000000" + h.slice(32) };
}
/** -> { state: "unanchored" } | { state: "anchored", digest } ; throws code "torn_anchor" / "bad_anchor" */
export function decodeAnchor(hi, lo) {
  const H = lc(hi), L = lc(lo);
  if (!ADDR.test(H) || !ADDR.test(L)) throw err("bad_anchor", "anchor: book values must be addresses");
  if (H === ZERO && L === ZERO) return { state: "unanchored" };
  if (H === ZERO || L === ZERO) throw err("torn_anchor", "anchor: exactly one half is set (torn or partial update); refusing");
  if (!H.startsWith("0x00000000") || !L.startsWith("0x00000000")) throw err("bad_anchor", "anchor: each half must be 16 bytes left-padded by 4 zero bytes");
  return { state: "anchored", digest: "0x" + H.slice(10) + L.slice(10) };
}
const BOOK_SET_ABI = [{ type: "function", name: "setMany", stateMutability: "nonpayable", inputs: [{ name: "keys_", type: "bytes32[]" }, { name: "values", type: "address[]" }], outputs: [] }];
/** The UNSIGNED admin transaction that anchors `digest` (EnclaveAddressBook.setMany, owner-only). For review; never sent here. */
export function anchorTransaction(book, digest) {
  const a = encodeAnchor(digest);
  return { to: lc(book), value: "0x0", data: encodeFunctionData({ abi: BOOK_SET_ABI, functionName: "setMany", args: [[ANCHOR_KEYS.hi, ANCHOR_KEYS.lo], [a.hi, a.lo]] }),
           function: `setMany([hostPolicyDigestHi, hostPolicyDigestLo], [${a.hi}, ${a.lo}])`, signer: "EnclaveAddressBook.owner() (the platform admin wallet)" };
}

// ---------------------------------------------------------------- signature
/** authority = { book, owner, ownerIsContract, isValid1271?(digest, sig) } read at an agreed block. -> { policy, digest } */
export async function verifySignedPolicy({ document, signature }, authority) {
  let p;
  try { p = validatePolicy(typeof document === "string" ? JSON.parse(document) : document); } catch (e) { throw err("bad_policy", e.message); }
  if (lc(p.book) !== lc(authority.book)) throw err("wrong_book", "policy names another address book");
  if (authority.registry && lc(p.registry) !== lc(authority.registry)) throw err("wrong_registry", "policy names another registry than the book does");
  if (authority.hostOwnership && lc(p.hostOwnership) !== lc(authority.hostOwnership)) throw err("wrong_ownership", "policy names another host-ownership extension");
  const digest = policyDigest(p);
  let ok = false;
  if (authority.ownerIsContract) ok = !!(authority.isValid1271 && await authority.isValid1271(digest, signature));
  else { try { ok = lc(await recoverTypedDataAddress({ ...policyTypedData(p), signature })) === lc(authority.owner); } catch { ok = false; } }
  if (!ok) throw err("bad_signature", "policy is not signed by the address book's current owner");
  return { policy: p, digest };
}

// ---------------------------------------------------------------- one agreed snapshot of the authority and host facts
const BOOK_ABI = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
                  { type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
const ERC1271 = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [{ type: "bytes4" }] }];
const OWN_ABI = [{ type: "function", name: "authority", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }] }];
const REG_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" }, { name: "active", type: "bool" }] }] }];
const REGISTRY_KEY = stringToHex("registry", { size: 32 });
/**
 * The facts a decision needs, at ONE block: book owner (+ whether it is a contract), the anchor halves, the book's registry,
 * and for each host id its registry operator/active/endpoint and ACCEPTED owner on `hostOwnership`. Signatures to check
 * against a contract owner are answered at the same block. `call(address, abi, fn, args)` and `code(address)` are bound
 * to that block by the caller (custody/v2/chain.mjs rdOf, or a LeaseReader snapshot).
 */
export async function readPolicyFacts({ call, code }, { book, hostOwnership, registryIds = [], check1271 = [] }) {
  const [owner, hi, lo, registry] = await Promise.all([call(book, BOOK_ABI, "owner"), call(book, BOOK_ABI, "addr", [ANCHOR_KEYS.hi]),
    call(book, BOOK_ABI, "addr", [ANCHOR_KEYS.lo]), call(book, BOOK_ABI, "addr", [REGISTRY_KEY])]);
  const c = await code(owner);
  const ownerIsContract = typeof c === "string" && c.length > 2;
  const hosts = {};
  for (const id of registryIds) {
    const [e, a] = await Promise.all([call(registry, REG_ABI, "get", [id]), call(hostOwnership, OWN_ABI, "authority", [id])]);
    hosts[lc(id)] = { registryId: lc(id), operator: lc(e.operator), active: !!e.active, endpoint: e.endpoint, owner: lc(a[0]) };
  }
  const valid1271 = {};
  if (ownerIsContract) for (const { digest, signature } of check1271) {
    try { valid1271[digest + ":" + signature] = lc(await call(owner, ERC1271, "isValidSignature", [digest, signature])) === "0x1626ba7e"; } catch { valid1271[digest + ":" + signature] = false; }
  }
  return { owner: lc(owner), ownerIsContract, anchorHi: lc(hi), anchorLo: lc(lo), registry: lc(registry), hosts, valid1271 };
}

// ---------------------------------------------------------------- decisions
export function policyStatus(policy, nowSec) {
  if (!policy) return "none";
  if (policy.expiresAt === 0) return "current";            // anchored non-expiring: the caller has checked the anchor
  if (nowSec <= policy.expiresAt) return "current";
  return nowSec <= policy.expiresAt + policy.maxStaleSec ? "stale-grace" : "stale";
}
/** host = { registryId, operator, owner (accepted, at the agreed block), chipId, endpoint } -> { admit, status, reason } */
export function judgeHost(policy, host, nowSec, { previouslyAdmitted = false } = {}) {
  const status = policyStatus(policy, nowSec);
  if (status === "none") return { admit: false, status, reason: "no platform host policy has been accepted" };
  const has = (e) => host[e.kind] !== undefined && host[e.kind] !== null && lc(host[e.kind]) === e.value;
  const ban = policy.deny.find(has);
  if (ban) return { admit: false, status, reason: `banned by platform policy #${policy.sequence} (${ban.kind}): ${ban.reason}` };
  if (policy.mode === "allowlist" && !policy.admit.some(has)) return { admit: false, status, reason: `not admitted by platform allowlist #${policy.sequence}` };
  if (status === "stale" && !previouslyAdmitted) return { admit: false, status, reason: "platform host policy is stale: new hosts are refused until a current policy is fetched" };
  return { admit: true, status, reason: status === "current" ? null : "platform host policy is stale; bans still enforced" };
}

// ---------------------------------------------------------------- the reusable loader + gate
/**
 * createPlatformHostGate({ book, hostOwnership, snapshot, mirrors, store, now, allowUnanchored })
 *   snapshot(fn): runs fn({ call, code, block }) at ONE majority-agreed fresh block and returns its result (custody
 *                 chain readers' agreed(), LeaseReader.agreed, ...). Minority RPCs cannot change the facts.
 *   mirrors:      [async (digest|null) -> [{ document, signature }]]  any transport; unauthenticated
 *   store:        { load() -> string|null, save(string) }  persisted { document, signature, digest, sequence }
 * Methods:
 *   refresh()                    -> accepted { policy, digest } or throws (code: torn_anchor, anchor_unavailable, ...)
 *   decide({ registryIds, extra })-> { block, decisions: { [registryId]: { admit, status, reason, host } } } judged against
 *                                   the anchor and the ACCEPTED owners at the same snapshot
 *   decideHost(facts, anchor)    -> judgement for host facts a caller already read at its own agreed block
 */
export function createPlatformHostGate({ book, hostOwnership, snapshot, mirrors = [], store = null, now = () => Date.now(), allowUnanchored = false, log = () => {} }) {
  if (!ADDR.test(lc(book)) || !ADDR.test(lc(hostOwnership)) || typeof snapshot !== "function") throw err("bad_config", "platform host gate: book, hostOwnership and a quorum snapshot are required");
  let accepted = null, highWater = null, persistedChecked = false;
  const problems = [];
  // CURRENT AUTHORITY, at ONE block (v2): every fact a decision or an acceptance uses - the anchor, the book owner, whether the
  // owner is a contract, its ERC-1271 answers, the host rows - comes from the SAME agreed snapshot. An accepted policy keeps
  // counting only while the book's CURRENT owner signs it at the decision block: an EOA owner's recovered signer, or a contract
  // owner's isValidSignature answered at that block. An owner rotation or a withdrawn ERC-1271 approval therefore stops
  // admission at once (status "authority": CONFIRMED at that block, an explicit refusal); facts that omit the owner are
  // "authority-unread" (undecided). The new or same owner re-signs the SAME document (same digest, no anchor write).
  const pairOf = (v) => (v ? [{ digest: v.digest, signature: v.signature }] : []);
  const authorityAt = (facts, v) => !!v && (facts.ownerIsContract ? facts.valid1271?.[v.digest + ":" + v.signature] === true : v.signer === lc(facts.owner));
  const authorityOf = (facts) => ({ book, registry: facts.registry, hostOwnership, owner: facts.owner, ownerIsContract: facts.ownerIsContract,
    isValid1271: async (d, sg) => facts.valid1271?.[d + ":" + sg] === true });
  const factsAt = (registryIds = [], pairs = []) => snapshot(async (at) => ({ ...(await readPolicyFacts(at, { book, hostOwnership, registryIds, check1271: pairs.slice(0, 40) })), block: at.block ?? null }));
  const parsePair = (c) => { try { const d = typeof c.document === "string" ? JSON.parse(c.document) : c.document; return { digest: policyDigest(d), signature: c.signature }; } catch { return null; } };
  async function verifyAt(c, facts) {
    const v = await verifySignedPolicy(c, authorityOf(facts));
    return { ...v, document: typeof c.document === "string" ? c.document : JSON.stringify(c.document), signature: c.signature, signer: facts.ownerIsContract ? null : lc(facts.owner) };
  }
  function persisted() {
    if (!store || persistedChecked) return null;
    persistedChecked = true;
    try { const raw = store.load(); return raw ? JSON.parse(raw) : null; } catch (e) { problems.push(`persisted policy unreadable: ${e.message}`); return null; }
  }
  function persist(v) {
    if (!store) return;
    try { store.save(JSON.stringify({ document: v.document, signature: v.signature, digest: v.digest, sequence: v.policy.sequence })); }
    catch (e) { problems.push(`persisting the accepted policy failed: ${e.message}`); log(`[host-policy] persisting the accepted policy failed: ${e.message}`); }
  }
  async function fetchCandidates(digest) {
    const out = [];
    for (const m of mirrors) { try { const r = await m(digest); if (Array.isArray(r)) out.push(...r.slice(0, 32)); } catch {} }
    return out;
  }
  async function refresh() {
    // 1. which digest is anchored (only to know what to fetch; nothing below trusts this snapshot)
    const probe = await factsAt([], pairOf(accepted));
    const anchor0 = decodeAnchor(probe.anchorHi, probe.anchorLo);         // torn/malformed -> throws
    if (anchor0.state === "anchored" && accepted?.digest === anchor0.digest && authorityAt(probe, accepted)) return accepted;   // same block: anchor + current owner + 1271
    // 2. candidates from mirrors (and the persisted record), then ONE snapshot answers anchor, owner and every 1271 question
    const rec = persisted();
    const cands = [...(rec && rec.document && rec.signature ? [{ document: rec.document, signature: rec.signature, persisted: rec }] : []),
                   ...(accepted ? [{ document: accepted.document, signature: accepted.signature }] : []),
                   ...(await fetchCandidates(anchor0.state === "anchored" ? anchor0.digest : null))];
    const facts = await factsAt([], cands.map(parsePair).filter(Boolean));
    const anchor = decodeAnchor(facts.anchorHi, facts.anchorLo);
    const valid = [];
    for (const c of cands) {
      try {
        const v = await verifyAt(c, facts);
        if (c.persisted) {
          if (v.digest !== c.persisted.digest || v.policy.sequence !== c.persisted.sequence) throw err("tampered", "persisted policy fields disagree with its document");
          if (!highWater || v.policy.sequence > highWater.sequence) highWater = { sequence: v.policy.sequence, digest: v.digest };
        }
        valid.push(v);
      } catch (e) { if (c.persisted) { problems.push(`persisted policy discarded: ${e.message}`); log(`[host-policy] persisted policy discarded: ${e.message}`); } }
    }
    let best;
    if (anchor.state === "anchored") {
      best = valid.find((v) => v.digest === anchor.digest);
      if (!best) {
        if (accepted?.digest === anchor.digest) { accepted = null; throw err("authority", "the anchored policy is no longer signed by the address book's current owner at this block (owner rotated or ERC-1271 approval withdrawn): it must be re-signed"); }
        throw err("anchor_unavailable", "the anchored policy is not available from any mirror (or does not verify against the current owner); refusing older or other policies");
      }
      if (highWater && best.policy.sequence < highWater.sequence) throw err("rollback", "the book anchors an older policy than this node already accepted");
      if (highWater && best.policy.sequence === highWater.sequence && best.digest !== highWater.digest) throw err("equivocation", "two different policies share one sequence");
    } else {
      if (!allowUnanchored) throw err("unanchored", "no policy is anchored in the address book; an enforcing gate refuses unanchored operation");
      const seqs = new Map();
      // an anchored-only (non-expiring) policy is never used unanchored
      for (const v of valid.filter((x) => x.policy.expiresAt !== 0)) { const q = seqs.get(v.policy.sequence); if (q && q.digest !== v.digest) throw err("equivocation", "two different policies share one sequence"); seqs.set(v.policy.sequence, v); }
      best = [...seqs.values()].sort((x, y) => y.policy.sequence - x.policy.sequence)[0];
      if (!best) throw err("policy_unavailable", "no valid policy from any mirror");
      if (highWater && (best.policy.sequence < highWater.sequence || (best.policy.sequence === highWater.sequence && best.digest !== highWater.digest))) { if (accepted) return accepted; throw err("rollback", "mirrors serve an older policy"); }
    }
    accepted = best; highWater = { sequence: best.policy.sequence, digest: best.digest }; persist(best);
    return accepted;
  }
  // A judgement is valid only against the policy the book anchors at the SAME block as the host facts AND only while the
  // book's current owner at that block signs it. `facts` must carry owner/ownerIsContract (and, for a contract owner, the
  // ERC-1271 answer for the accepted policy) from that block - readPolicyFacts with check1271 = currentAuthorityChecks().
  function decideHost(host, facts, { previouslyAdmitted = false } = {}) {
    let anchor;
    try { anchor = decodeAnchor(facts.anchorHi, facts.anchorLo); } catch (e) { return { admit: false, status: "anchor", reason: e.message }; }
    if (anchor.state === "anchored" && accepted?.digest !== anchor.digest) return { admit: false, status: "behind", reason: "this node has not loaded the policy the book anchors at this block" };
    if (anchor.state === "unanchored" && !allowUnanchored) return { admit: false, status: "unanchored", reason: "no platform host policy is anchored" };
    if (anchor.state === "unanchored" && accepted?.policy.expiresAt === 0) return { admit: false, status: "unanchored", reason: "the accepted policy is valid only while anchored, and the book anchors none" };
    if (accepted) {
      // facts without the owner are UNREAD authority (undecided), never a confirmed invalidation
      if (typeof facts.owner !== "string") return { admit: false, status: "authority-unread", reason: "the decision's facts carry no current book owner (same-block authority required)" };
      if (!authorityAt(facts, accepted)) return { admit: false, status: "authority", reason: "the accepted policy is not signed by the address book's current owner at this block (rotated owner or withdrawn ERC-1271 approval)" };
    }
    return judgeHost(accepted?.policy || null, host, Math.floor(now() / 1000), { previouslyAdmitted });
  }
  async function decide({ registryIds = [], extra = {}, previouslyAdmitted = () => false } = {}) {
    const facts = await factsAt(registryIds, pairOf(accepted));
    const decisions = {};
    for (const id of registryIds.map(lc)) {
      const h = { ...facts.hosts[id], ...(extra[id] || {}) };
      decisions[id] = { ...(h.active ? decideHost(h, facts, { previouslyAdmitted: previouslyAdmitted(id) }) : { admit: false, status: "inactive", reason: "host registry entry is not active" }), host: h };
    }
    return { block: facts.block, decisions };
  }
  // operator-keyed decisions (discovery ads carry only an operator): registry/owner-keyed rules cannot be judged here and
  // are enforced again where the host is used (route, custody, management, measured guest)
  async function decideOperators(operators = []) {
    const facts = await factsAt([], pairOf(accepted));
    return Object.fromEntries(operators.map((o) => [lc(o), decideHost({ operator: lc(o) }, facts)]));
  }
  // the ERC-1271 questions a caller's own same-block snapshot must ask for decideHost (custody chain reads)
  const currentAuthorityChecks = () => pairOf(accepted);
  return { refresh, decide, decideHost, decideOperators, currentAuthorityChecks, accepted: () => accepted, problems: () => [...problems] };
}

/** A gate that admits everything and says so: the explicit "enforcement off" mode (today's behavior), never a fallback. */
export const PLATFORM_POLICY_OFF = Object.freeze({ off: true, decideHost: () => ({ admit: true, status: "off", reason: "platform host policy enforcement is off" }) });
