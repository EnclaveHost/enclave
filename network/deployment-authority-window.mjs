// Separate policy finality from observation freshness. Old authenticated policy
// may be usable only within an explicitly owner-authorized lag bound AND with a
// fresh authenticated current-state denial check. An unsafe head can revoke,
// never supply an owner, witness set, funding grant or restoration.
export const OBSERVATION_SEC = 20, SKEW_SEC = 2, MAX_ANCHOR_LAG_SEC = 3600;
const HASH = /^0x[0-9a-f]{64}$/;
const integer = n => Number.isSafeInteger(n) && n >= 0;
function timestamp(n, now, maxAge, what) {
  if (!integer(n) || n > now + SKEW_SEC || now - n > maxAge) throw Error(`stale or invalid ${what}`);
}
export function validateLifecycleAuthorityWindow({ anchor, head, policy, nowSec, denyFloor = null }) {
  if (!integer(nowSec)) throw Error('invalid authority clock');
  const lag = policy?.maxAnchorAgeSec;
  if (!Number.isInteger(lag) || lag < OBSERVATION_SEC || lag > MAX_ANCHOR_LAG_SEC)
    throw Error('owner-authorized anchor lag required');
  if (anchor?.proofVerified !== true || !['safe', 'finalized', 'l1-finalized-derived'].includes(anchor.tier) ||
      !HASH.test(anchor.hash || '') || !integer(anchor.number)) throw Error('unqualified policy anchor');
  timestamp(anchor.timestamp, nowSec, lag, 'policy anchor');
  timestamp(anchor.observedAt, nowSec, OBSERVATION_SEC, 'policy verification');
  if (head?.proofVerified !== true || !['unsafe', 'safe', 'finalized', 'l1-finalized-derived'].includes(head.tier) ||
      !HASH.test(head.hash || '') || !integer(head.number) || head.number < anchor.number ||
      head.anchorHash !== anchor.hash || head.ancestryVerified !== true)
    throw Error('unqualified current denial check');
  timestamp(head.timestamp, nowSec, OBSERVATION_SEC, 'current head');
  timestamp(head.observedAt, nowSec, OBSERVATION_SEC, 'current verification');
  if (typeof head.denied !== 'boolean') throw Error('current denial result unknown');
  if (head.denied) throw Object.assign(Error('deployment denied; authenticated restoration required'), {
    code: 'LIFECYCLE_DENIED', denial: { blockNumber: head.number, blockHash: head.hash, observedAt: head.observedAt, revision: policy.revision } });
  if (denyFloor) throw Error('deployment denied; authenticated restoration required');
  if (anchor.admitted !== true || anchor.funded !== true) throw Error('policy anchor does not grant service');
  if (!integer(anchor.fundedUntil) || anchor.fundedUntil <= nowSec) throw Error('funded runtime exhausted');
  return { validUntil: Math.min(anchor.timestamp + lag, anchor.observedAt + OBSERVATION_SEC,
    head.timestamp + OBSERVATION_SEC, head.observedAt + OBSERVATION_SEC, anchor.fundedUntil),
    anchorAgeSec: nowSec - anchor.timestamp, observationAgeSec: nowSec - anchor.observedAt,
    // This is the conservative worst-case revocation delay if the current
    // authenticated chain has not yet incorporated a policy transaction.
    maxPolicyLagSec: lag };
}

// A denial observed on an unsafe fork stays sticky until positive FINALIZED
// policy at or beyond that height establishes restoration (or excludes that
// fork). An unsafe "allowed again" result can never clear this floor.
export function canRestoreLifecycleDenial(denial, anchor, nowSec) {
  return !!(denial && anchor?.proofVerified === true && ['finalized', 'l1-finalized-derived'].includes(anchor.tier) &&
    integer(anchor.number) && anchor.number >= denial.blockNumber && HASH.test(anchor.hash || '') &&
    integer(anchor.observedAt) && anchor.observedAt <= nowSec + SKEW_SEC && nowSec - anchor.observedAt <= OBSERVATION_SEC &&
    anchor.admitted === true && anchor.funded === true && anchor.fundedUntil > nowSec);
}
