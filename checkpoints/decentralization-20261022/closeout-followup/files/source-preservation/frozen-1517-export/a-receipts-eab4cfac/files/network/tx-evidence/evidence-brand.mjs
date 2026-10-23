// Evidence that only the SOURCE-BINDING adapters can mint (src/l1-source-binding.mjs, src/base-source-binding.mjs).
// A string label ('l1-execution-proof') or caller-supplied JSON is not evidence: the transaction checks in
// src/forced-inclusion.mjs accept an L1/L2 inclusion or finality claim by default ONLY when the object was produced by
// an adapter that read it from an explicitly configured, readiness-checked local client pair.
//
// IMMUTABILITY: mint() takes an OWNED deep copy of what the adapter read (structuredClone: BigInt, nested receipts,
// logs, topics, transaction, heads, finality checkpoint, source) and deep-freezes it, so the validated facts a brand
// vouches for cannot change afterwards: not the receipt's status or logs, not the transaction nonce, not `finalized`.
// The adapter's own working objects and anything a caller passed in are copied, never frozen in place. The adapters
// hand callers the frozen receipt itself (`result.receipt === result.evidence.receipt`), so identity checks still work.
//
// Scope of this guarantee: an in-process capability (a module-private WeakSet), not cryptography. `mint` is an
// ordinary export: any code in the same process can call it, so it stops callers, config files and remote endpoints
// from ASSERTING or ALTERING evidence by accident or by data, not code that deliberately mints its own. The TRUST
// behind a minted object is recorded on it (`trust`): 'local-validated-pair' = "the local full nodes executed/validated
// this chain and their consensus client finalized it" (local full-node validation trust), NOT a portable proof.
// 'test-fixture' marks objects from labelled fixtures, which the default checks refuse.
const MINTED = new WeakSet();
export const TRUST = Object.freeze({ LOCAL_VALIDATED_PAIR: 'local-validated-pair', TEST_FIXTURE: 'test-fixture' });

function deepFreeze(v) {
  if (v === null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) throw new TypeError('evidence must not carry binary buffers (hex strings only)');
  for (const k of Reflect.ownKeys(v)) deepFreeze(v[k]);
  return Object.freeze(v);
}
export function mint(obj) {
  const owned = deepFreeze(structuredClone(obj));   // throws on functions/symbols: evidence is plain data only
  MINTED.add(owned);
  return owned;
}
export const isMinted = (obj) => obj !== null && typeof obj === 'object' && MINTED.has(obj);
