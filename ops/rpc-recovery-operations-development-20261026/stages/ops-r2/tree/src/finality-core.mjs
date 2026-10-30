// finality-core.mjs: post-anchor finality of OUR launched Base chain, qualified from a FRESH A1-authenticated anchor N' > N
// (base-finality-proof-stage, PREPARED; not run). Pure ES module except `io.l2` (injected JSON-RPC to the BOUND local node).
//
// Rule (vendor/anchor-bootstrap.mjs header, root review 2026-10-25): a block hash commits to its PARENT, never to its children.
// So blocks above the launch anchor N are NEVER authenticated from N. They are authenticated here ONLY as ANCESTORS of a newer
// anchor N' whose output root a fresh, L1-finalized A1 receipt names:
//   1. header N' from our node must reproduce that output root (authenticateAnchor, reused unchanged);
//   2. walking DOWN from N', every header N'..N must hash-link (authenticateAncestors, reused unchanged, in chunks: each chunk
//      ends at the authenticated parentHash of the chunk above it);
//   3. the walk must END at the ORIGINAL launch anchor: header N's recomputed hash == the launch record's anchor hash, and
//      header N reproduces the ORIGINAL A1 output root (authenticateAnchor again, with the launch-record values);
//   4. every previously qualified (n, hash) in [N, N'] must be on this path (a reorg/DB swap after a qualification is a contradiction).
// Our node's own `latest`/`safe`/`finalized` labels are NEVER requested or used: every read is by explicit number, and its
// answer is only an untrusted claim until its recomputed hash links into the authenticated path.
//
// Outcomes: a verdict, a FinalityRefusal (no evidence either way: not synced, malformed, too long, wrong chain id) or a
// FinalityContradiction (authenticated values and our bound node's chain DISAGREE: the caller records it as terminal).
import { authenticateAnchor, authenticateAncestors, AnchorBootstrapError } from "../vendor/anchor-bootstrap.mjs";

export const VERDICT = "post-anchor-finality-qualified";
export const BASE_CHAIN_ID = "0x2105";                     // 8453
export const DEFAULT_CHUNK = 512;
export const MAX_SPAN = 4_000_000;                         // ~92 days of 2 s blocks; above this the caller re-anchors (refusal)
export class FinalityRefusal extends Error { constructor(code, message) { super(message); this.code = code; this.kind = "refusal"; } }
export class FinalityContradiction extends Error { constructor(code, message) { super(message); this.code = code; this.kind = "contradiction"; } }
const refuse = (code, m) => { throw new FinalityRefusal(code, m); };
const contradict = (code, m) => { throw new FinalityContradiction(code, m); };
const H32 = /^0x[0-9a-f]{64}$/;
const lc = (s) => String(s).toLowerCase();
const qhex = (n) => "0x" + n.toString(16);
// authenticateAnchor/authenticateAncestors codes that mean "our node's data disagrees with authenticated values"
const CONTRADICTING = new Set(["hash_claim", "anchor_number", "output_root", "anchor_mismatch", "descendant", "discontinuity", "unlinked"]);
const classify = (e, where) => {
  if (e instanceof AnchorBootstrapError) {
    if (CONTRADICTING.has(e.code)) contradict(`${where}:${e.code}`, e.message);
    refuse(`${where}:${e.code}`, e.message);                 // bad_input / not_isthmus / no_anchor: malformed, not evidence
  }
  throw e;
};

function checkInputs(original, fresh, prior) {
  for (const [k, v] of Object.entries({ "original.N": original?.N, "fresh.N": fresh?.N })) if (!Number.isSafeInteger(v) || v < 1) refuse("bad_input", `${k} must be a positive safe integer`);
  if (!H32.test(lc(original.blockHash)) || !H32.test(lc(original.outputRoot)) || !H32.test(lc(fresh.outputRoot))) refuse("bad_input", "hashes/roots must be 32-byte hex");
  if (fresh.N <= original.N) refuse("not_post_anchor", `fresh anchor ${fresh.N} is not above the launch anchor ${original.N}: nothing above N is qualified`);
  if (fresh.N - original.N > MAX_SPAN) refuse("span_too_long", `span ${fresh.N - original.N} exceeds ${MAX_SPAN}`);
  if (!Array.isArray(prior)) refuse("bad_input", "prior must be an array of {N, blockHash}");
  for (const p of prior) if (!Number.isSafeInteger(p?.N) || !H32.test(lc(p?.blockHash))) refuse("bad_input", "prior entries must be {N, blockHash}");
  for (const p of prior) if (p.N >= fresh.N) refuse("not_newer", `fresh anchor ${fresh.N} is not above the already qualified ${p.N} (stale or replayed proof)`);
}

/**
 * qualify({ original: {N, blockHash, outputRoot}  (from the pinned launch record),
 *           fresh:    {N, outputRoot}             (from the fresh A1 receipt, already gated by the caller),
 *           prior:    [{N, blockHash}]            (earlier qualified points of THIS launch) },
 *         io:  { l2(method, params) -> result }   (JSON-RPC to the process-bound local node; untrusted),
 *         opts:{ keccak, chunk })
 */
export async function qualify({ original, fresh, prior = [] }, io, { keccak, chunk = DEFAULT_CHUNK } = {}) {
  checkInputs(original, fresh, prior);
  if (!Number.isSafeInteger(chunk) || chunk < 2 || chunk > 4096) refuse("bad_input", "chunk must be 2..4096");
  const rpc = async (method, params) => {
    if (method !== "eth_chainId" && method !== "eth_getBlockByNumber") refuse("bad_rpc", `method ${method} is not used`);
    if (method === "eth_getBlockByNumber" && !/^0x[0-9a-f]+$/.test(params[0])) refuse("label_refused", `block selector ${params[0]} is a label: only explicit numbers are read`);
    try { return await io.l2(method, params); } catch (e) { refuse("rpc_failed", `${method}: ${String(e?.message || e).slice(0, 160)}`); }
  };
  const header = async (n) => {
    const h = await rpc("eth_getBlockByNumber", [qhex(n), false]);
    if (h === null || h === undefined) refuse("not_synced", `our node has no block ${n} yet (the fresh anchor is ahead of the local chain)`);
    if (typeof h !== "object") refuse("bad_rpc", `block ${n} answer is not an object`);
    return h;
  };
  if (lc(await rpc("eth_chainId", [])) !== BASE_CHAIN_ID) refuse("wrong_chain", "the bound node is not Base mainnet (chain id 8453)");
  const priorAt = new Map(prior.filter((p) => p.N >= original.N && p.N <= fresh.N).map((p) => [p.N, lc(p.blockHash)]));
  const checked = [];

  // 1. the fresh anchor N': header from our node, authenticated ONLY by reproducing the fresh A1 output root
  const top = await header(fresh.N);
  let freshAuth;
  try { freshAuth = authenticateAnchor({ rootClaim: lc(fresh.outputRoot), l2BlockNumber: fresh.N }, top, keccak); } catch (e) { classify(e, "fresh_anchor"); }

  // 2.+3.+4. walk DOWN from N' to the ORIGINAL N, chunk by chunk
  let end = { number: fresh.N, blockHash: freshAuth.blockHash }, headerN = null, cached = top;
  while (true) {
    const lo = Math.max(original.N, end.number - chunk + 1);
    const hs = [];
    for (let n = lo; n <= end.number; n++) hs.push(n === end.number && cached ? cached : await header(n));
    let m;
    try { m = authenticateAncestors(hs, end, keccak); } catch (e) { classify(e, "ancestry"); }
    for (const [n, want] of priorAt) if (m.has(n)) { if (m.get(n).hash !== want) contradict("prior_qualified_not_ancestor", `previously qualified block ${n} ${want} is not on the path to the fresh anchor`); checked.push(n); }
    if (lo === original.N) { headerN = hs[0]; break; }
    end = { number: lo - 1, blockHash: lc(hs[0].parentHash) };   // the authenticated parent of the lowest authenticated header
    cached = null;
  }
  // 3. the walk ended at the ORIGINAL N: header N (now an authenticated ancestor of N') must reproduce the ORIGINAL A1 output
  //    root and hash to the launch record's anchor hash; anything else means our chain is not the one we launched
  let origAuth;
  try { origAuth = authenticateAnchor({ rootClaim: lc(original.outputRoot), l2BlockNumber: original.N }, headerN, keccak); } catch (e) { classify(e, "original_anchor"); }
  if (origAuth.blockHash !== lc(original.blockHash)) contradict("original_anchor_not_ancestor", `block ${original.N} on the path to the fresh anchor is ${origAuth.blockHash}, the launch anchor is ${lc(original.blockHash)}`);
  for (const n of priorAt.keys()) if (!checked.includes(n)) contradict("prior_unchecked", `previously qualified block ${n} was not covered by the walk`);
  return { verdict: VERDICT, original: { N: original.N, blockHash: origAuth.blockHash, stateRoot: origAuth.stateRoot },
           fresh: { N: fresh.N, blockHash: freshAuth.blockHash, stateRoot: freshAuth.stateRoot },
           span: fresh.N - original.N, priorChecked: checked.sort((a, b) => a - b) };
}
