// Shared verification primitives for the relay routes a FLEET MEMBER calls
// (secrets.js fetch, certs.js issue): the per-endpoint operator lookup with
// its fail-closed cache, EIP-191 signer recovery, single-use signature
// tracking, and the "does this endpoint hold the live lease" read. Factored
// out of secrets.js when certs.js needed the same three checks — one spelling
// of each rule, so a fix to the cache or the lease test lands on every route.
//
// Nothing here answers HTTP; the callers own their status codes and messages.

import { createHash } from "node:crypto";

// WHO OWNS an endpoint on chain, cached like the tunnel hub's owner cache: a
// registry read that FAILS must not open an endpoint we have already seen
// registered, and an endpoint never seen registered stays as it was.
const _epOwner = new Map();
export async function endpointOperator(ctx, endpoint) {
  if (!ctx.operatorOfEndpoint) return null;                 // older relay wiring: unchanged behaviour
  try {
    const a = await ctx.operatorOfEndpoint(endpoint);
    if (a) _epOwner.set(endpoint, String(a).toLowerCase());
    else _epOwner.delete(endpoint);
    return a ? String(a).toLowerCase() : null;
  } catch {
    return _epOwner.get(endpoint) || null;                  // fail closed against a known owner
  }
}

// Recover the signer of a personal_sign over `message`, or null.
export async function recoverOp(message, sig) {
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return null;
  try {
    const { recoverMessageAddress } = await import("viem");
    return (await recoverMessageAddress({ message, signature: sig })).toLowerCase();
  } catch { return null; }
}

// Single-use signatures: a captured signature must not replay within its
// validity window. Bounded map, pruned as it's touched. `expiry` is the unix
// second past which the mark can be forgotten.
export function makeReplayCache() {
  const seen = new Map();                                     // sha256(sig) -> expiry(sec)
  return (signature, expiry) => {
    const now = Math.floor(Date.now() / 1000);
    if (seen.size > 10_000) for (const [k, e] of seen) if (e < now) seen.delete(k);
    const mark = createHash("sha256").update(String(signature)).digest("base64");
    if (seen.has(mark)) return false;
    seen.set(mark, expiry);
    return true;
  };
}

// Resolve one ledger row by exact id (lowercased bytes32); a force-refreshed
// second read covers the seconds right after a claim/create when the relay's
// 10s ledger cache predates the tx.
export async function rowOf(ctx, id, { fresh = false } = {}) {
  if (fresh) ctx.ledgerExpire();
  let rows; try { rows = await ctx.ledgerRows(); } catch { return null; }
  return rows.find((d) => String(d.id).toLowerCase() === id) || null;
}

// The lease test every fleet route applies: a non-zero runner equal to the
// endpoint's registry id, with the lease still in the future.
export const holdsLease = (row, epId) => !!row && !/^0x0+$/.test(String(row.runner))
  && Number(row.leaseUntil) * 1000 > Date.now() && String(row.runner).toLowerCase() === String(epId).toLowerCase();
