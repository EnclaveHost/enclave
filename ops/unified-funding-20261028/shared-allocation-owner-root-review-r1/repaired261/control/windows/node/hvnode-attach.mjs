// windows/node/hvnode-attach.mjs - what an hv-node attach carries beyond its evidence: the OPERATOR's signature over the
// attach, and the owners' DELEGATIONS, so the relay serves exactly the owners this node serves (enclave-87's (B), the
// format and checks enclave-e3's host-delegation.mjs).
//
//   v1  personal_sign of "enclave-tunnel-attach:<name>:<nonce b64>" - proves the registered operator is attaching. Every
//       relay verifies it; a relay records NO served owner from it, so a v1 attach serves nothing of an owner's.
//   v2  personal_sign of attachMessageV2(name, nonce, keyFp, ekCertSha256) - the operator consents to THIS transport key
//       on THIS TPM, and only then does a relay record the operator and read the delegations beside it.
//
// The node signs v2 ONLY when the relay's challenge says it verifies v2 (sigVersions includes 2). A relay without that
// wiring checks v1 alone and would REFUSE a registered name signed v2, so a node that always signed v2 could not attach
// to it at all. Nothing is widened by a v1 attach, so following the challenge cannot be used to gain anything.
import { createHash } from "node:crypto";
import { attachMessageV2, MAX_DELEGATIONS, MAX_DELEGATION_BYTES } from "./host-delegation.mjs";

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
export const attachMessageV1 = (name, nonceB64) => `enclave-tunnel-attach:${name}:${nonceB64}`;

/** Does this challenge say the relay verifies attach signature v2? */
export const relayTakesV2 = (challenge) => Array.isArray(challenge?.sigVersions) && challenge.sigVersions.includes(2);

/**
 * attachExtras -> { operatorSig, version, message, keyFp, ekCertSha256, delegations }
 *   name, nonceB64   the attach name and the relay's challenge nonce, exactly as received
 *   spki             the transport key's SPKI DER (the bytes of rad.transportKey)
 *   ekCertDer        the EK certificate DER this attach sent in vbs-keys (v2 binds its sha256)
 *   v2               relayTakesV2(challenge)
 *   sign(message)    the operator key's personal_sign, or null when there is no operator key (then no signature)
 *   delegations      [{ message, signature }] - the VALID ones this node serves (host.attachDelegations); sent with v2 only
 */
export async function attachExtras({ name, nonceB64, spki, ekCertDer, v2 = false, sign = null, delegations = [] }) {
  const keyFp = sha256hex(spki);
  const ekCertSha256 = ekCertDer && ekCertDer.length ? sha256hex(ekCertDer) : null;
  if (v2 && !ekCertSha256) throw new Error("attach signature v2 binds the EK certificate, and this attach sent none");
  const message = v2 ? attachMessageV2(name, nonceB64, keyFp, ekCertSha256) : attachMessageV1(name, nonceB64);
  const operatorSig = sign ? await sign(message) : null;
  const sent = !v2 ? [] : (Array.isArray(delegations) ? delegations : [])
    .filter((d) => d && typeof d.message === "string" && typeof d.signature === "string"
                && d.message.length <= MAX_DELEGATION_BYTES && d.signature.length <= MAX_DELEGATION_BYTES)
    .slice(0, MAX_DELEGATIONS)
    .map((d) => ({ message: d.message, signature: d.signature }));        // the file's own strings, never re-encoded
  return { operatorSig, version: v2 ? 2 : 1, message, keyFp, ekCertSha256, delegations: sent };
}

/**
 * Should the node attach again because the owners it serves changed since this attach? The relay reads the delegations
 * only at attach, so a removed, expired or added one reaches it only through a new attach. At most once per minGapMs,
 * so a directory that flickers (a transient read error) cannot turn into a reconnect loop.
 */
export function shouldReattach({ attached, attachedVersion, currentVersion, lastRedialMs = 0, nowMs = Date.now(), minGapMs = 120_000 }) {
  if (!attached || attachedVersion == null || currentVersion == null) return false;
  if (attachedVersion === currentVersion) return false;
  return nowMs - lastRedialMs >= minGapMs;
}

/**
 * How an owners change re-attaches (enclave-87's ruling on enclave-bf's NO-GO): "make-before-break" (a standby tunnel,
 * no gap: tunnel-handover.mjs) ONLY when the new served set is a SUPERSET of the attached one. If any owner was REMOVED
 * - a delegation deleted, expired or no longer valid - "break-before-make": the live tunnel ends NOW, so the relay stops
 * serving that owner at once whatever becomes of the new attach (the relay re-checks a delegation's expiry itself, but a
 * removal only the node can see). An attached set it does not know is treated as a removal.
 */
export function reattachMode({ attached, current }) {
  if (!Array.isArray(attached) || !Array.isArray(current)) return "break-before-make";
  const now = new Set(current.map((o) => String(o).toLowerCase()));
  return attached.every((o) => now.has(String(o).toLowerCase())) ? "make-before-break" : "break-before-make";
}

/** Put attachExtras' results onto an hv-node attest frame ({ t: "attest", rad }): operatorSig on the frame, the
 *  delegations on rad (sent with v2 only). -> attachExtras' result. */
export async function finishHvAttach(frame, opts) {
  const x = await attachExtras(opts);
  if (x.operatorSig) frame.operatorSig = x.operatorSig;
  if (x.delegations.length) frame.rad.delegations = x.delegations;
  return x;
}
