// finalized-anchor.mjs (finalized-consumer-interface-stage; PREPARED, NOT run, NOT integrated). The minimal JS consumer interface for
// an AUTHENTICATED FINALIZED Base anchor + state, composed ONLY from existing pinned, pure verification code:
//   ./a1-anchor.mjs       (ec92b70f...: runA1 - ASR anchor/game finality from a Helios-FINALIZED L1 block, MPT pins; checkProofResponse)
//   ./anchor-bootstrap.mjs (90a8afba...: authenticateAnchor - Base header N reproduces the L1-authenticated output root; headerHash)
// TRUST BOUNDARY: every function here must run INSIDE the consumer's accepted domain (the SNP chain-verifier VM or the consumer
// itself) with io.l1.helios = an L1 (ethereum-mode) light client running in THAT domain. Every other input (L1 EL proofs, Base headers,
// Base eth_getProof answers) may come from any untrusted server, including our non-SNP RPC VM: it is verified here, never trusted.
// A root-owned receipt or status file from the RPC VM (finality_state status, capture evidence) is NOT an input.
// What this does NOT do: it never authenticates a block ABOVE the anchor (a hash commits to its parent, not its children); the
// sequencer-signed head is a separate, deny-only check (checkHeadAgainstAnchor) and is never relabelled finalized.
import { runA1, checkProofResponse } from "./a1-anchor.mjs";
import { authenticateAnchor, headerHash } from "./anchor-bootstrap.mjs";

export const FINALIZED_ANCHOR_FORMAT = "enclave-base-finalized-anchor/v1";
export class FinalizedAnchorError extends Error { constructor(code, message) { super(message); this.code = code; } }
const refuse = (code, m) => { throw new FinalizedAnchorError(code, m); };
const H32 = /^0x[0-9a-f]{64}$/;
const lc = (s) => String(s).toLowerCase();

/**
 * authenticateFinalizedAnchor({ a1Config, l1, base, keccak, now, maxAnchorAgeSec })
 *   a1Config        the root-reviewed A1 config (portal, asr, portalAsrGetter, pinBy "hash", maxFinalizedAgeSec, asrCandidates; the
 *                   heliosUrl/elUrl fields are ignored here: transports are injected)
 *   l1              { helios(method, params), el(method, params) }: helios = the IN-DOMAIN L1 light client (the only L1 authority),
 *                   el = any L1 execution endpoint (untrusted proof source). Use cold-proof r3 a1io() deadlines.
 *   base            { request(method, params) }: any Base RPC (untrusted header source)
 *   maxAnchorAgeSec 0 = finality-only (no age bound, owner opt-in); > 0 refuses an anchor whose OWN Base block timestamp is older.
 *                   The age is the anchor block's timestamp, never the time we observed it: re-observing an old anchor never refreshes it.
 * -> Object.freeze(FinalizedAnchor) (shape in CONTRACT.md); throws A1Error (L1 side) or FinalizedAnchorError (Base side / age).
 */
export async function authenticateFinalizedAnchor({ a1Config, l1, base, keccak, now = () => Date.now(), maxAnchorAgeSec }) {
  if (!Number.isSafeInteger(maxAnchorAgeSec) || maxAnchorAgeSec < 0) refuse("bad_input", "maxAnchorAgeSec must be an explicit integer >= 0 (0 = finality-only)");
  if (a1Config?.pinBy !== "hash") refuse("bad_input", "a1Config.pinBy must be \"hash\" (every L1 read at one Helios-finalized block)");
  const a1 = await runA1(a1Config, { helios: l1.helios, el: l1.el }, { keccak, headerHash, now });   // L1 finality + ASR anchor + game
  const n = Number(a1.N);
  if (!Number.isSafeInteger(n) || n < 1) refuse("bad_anchor", `anchor number ${a1.N} is not a positive safe integer`);
  const hdr = await base.request("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
  if (!hdr || typeof hdr !== "object") refuse("anchor_header_missing", `the Base source has no block ${n}`);
  const anchor = authenticateAnchor({ rootClaim: a1.outputRoot, l2BlockNumber: n }, hdr, keccak);   // recomputed hash + output root
  const ts = Number(BigInt(hdr.timestamp));
  const ageSec = Math.floor(now() / 1000) - ts;
  if (ageSec < -15) refuse("anchor_future", `anchor block timestamp is ${-ageSec} s in the future`);
  if (maxAnchorAgeSec > 0 && ageSec > maxAnchorAgeSec) refuse("anchor_too_old", `anchor block ${n} is ${ageSec} s old (max ${maxAnchorAgeSec})`);
  return Object.freeze({
    format: FINALIZED_ANCHOR_FORMAT, tier: "finalized", finality: "l1-finalized-asr-anchor",
    base: Object.freeze({ number: n, hash: anchor.blockHash, stateRoot: anchor.stateRoot, messagePasserStorageRoot: anchor.messagePasserStorageRoot,
                          timestamp: ts, outputRoot: lc(a1.outputRoot) }),
    game: lc(a1.game), asr: lc(a1.asr), respectedGameType: a1.respectedGameType,
    l1: Object.freeze({ number: a1.l1.number, hash: lc(a1.l1.hash), stateRoot: lc(a1.l1.stateRoot), timestamp: a1.l1.timestamp }),
    anchorAgeSec: ageSec, maxAnchorAgeSec, observedAt: new Date(now()).toISOString(),
  });
}

/**
 * readAnchorAccount(anchor, base, address, slots, keccak) -> { nonce, balance, storageRoot, codeHash, storage{slot32: bigint} }
 * Base state AT the authenticated anchor: eth_getProof pinned by the anchor's block HASH from any Base source, every account and
 * storage value proven against anchor.base.stateRoot (checkProofResponse). Limitation: the source must still hold proofs for that
 * (days-old) block - our own Base node's --rpc.eth-proof-window is 1800 blocks (see CONTRACT.md).
 */
export async function readAnchorAccount(anchor, base, address, slots, keccak) {
  if (anchor?.format !== FINALIZED_ANCHOR_FORMAT || !H32.test(anchor.base?.stateRoot || "")) refuse("bad_input", "not an authenticated finalized anchor");
  const r = await base.request("eth_getProof", [address, slots, { blockHash: anchor.base.hash }]);
  if (!r || lc(r.address) !== lc(address)) refuse("proof_address", "eth_getProof answered another address");
  return checkProofResponse(anchor.base.stateRoot, r, keccak);
}

/**
 * checkHeadAgainstAnchor(anchor, head, { now, maxHeadAgeMs, headers, keccak, maxDepth }) -> { deny: boolean, reasons: [...], tier: "unsafe" }
 * DENY-ONLY. `head` = {number, hash, timestamp(ms)} from the separately authenticated sequencer-signed head authority (the SNP
 * opstack verifier: pinned unsafe_signer). Denies when the signed head is below the finalized anchor, stale, or (when `headers` -
 * the ascending Base headers anchor..head from any source - are given) does not descend from the anchor by recomputed hash links.
 * A non-deny result NEVER upgrades the head: it stays tier "unsafe", finality "none".
 */
export function checkHeadAgainstAnchor(anchor, head, { now = () => Date.now(), maxHeadAgeMs = 60_000, headers, keccak, maxDepth = 4096 } = {}) {
  const reasons = [];
  const hn = Number(head?.number);
  if (!Number.isSafeInteger(hn) || !H32.test(lc(head?.hash || ""))) reasons.push("malformed_head");
  else {
    if (hn < anchor.base.number) reasons.push("head_below_finalized_anchor");
    if (!(now() - Number(head.timestamp) <= maxHeadAgeMs)) reasons.push("head_stale");
    if (headers !== undefined) {
      if (!Array.isArray(headers) || headers.length !== hn - anchor.base.number + 1 || headers.length > maxDepth) reasons.push("descent_unchecked");
      else {
        let prev = null;
        for (let i = 0; i < headers.length; i++) {
          const h = headerHash(headers[i], keccak, { requireIsthmus: true });
          if (Number(BigInt(headers[i].number)) !== anchor.base.number + i || (i === 0 ? h !== anchor.base.hash : lc(headers[i].parentHash) !== prev)) {
            reasons.push("head_not_descendant_of_finalized_anchor"); break;
          }
          prev = h;
        }
        if (!reasons.length && prev !== lc(head.hash)) reasons.push("head_not_descendant_of_finalized_anchor");
      }
    }
  }
  return Object.freeze({ deny: reasons.length > 0, reasons, tier: "unsafe", finality: "none" });
}
