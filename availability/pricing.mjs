// Deterministic quote policy. All monetary values are integer USDC micro-units.
// Aggregation must supply finalized paid CUSTOMER demand and independently
// qualified capacity for ONE comparable resource/isolation class. Verification
// jobs never count as customer demand. This module does not attest the inputs.
const SCALE = 1_000_000n;
function integer(value, name, positive = false) {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n))
    throw new TypeError(`${name} must be a ${positive ? 'positive' : 'nonnegative'} bigint`);
  return value;
}
const min = (...v) => v.reduce((a, b) => a < b ? a : b);
const max = (a, b) => a > b ? a : b;

/** A fixed-duration paid verification offer. Never changes a running lease.
 * demand/supply use normalized resource-seconds over the SAME observation window,
 * not wallet/host counts. Supply includes occupied capacity, preventing an idle
 * pool shrinking during useful work from being mistaken for lost hardware.
 * Capacity offers apply only to spare allocations; customer work has priority.
 * anchorRate6 is the agreed reference rate for this class, not the target's ask.
 * Prior pricing is persisted, epoch ordered, and bounded by elapsed time so
 * rapid repeated calls cannot ratchet the quote. Actual transfer caps are still
 * enforced by the payer's on-chain spending authorization.
 */
export function quoteVerification({ observation, previous = null, policy, nowSec,
  durationSec, availableBudget6, hostMinimumRate6, spareUnits }) {
  integer(nowSec, 'nowSec'); integer(durationSec, 'durationSec', true);
  integer(availableBudget6, 'availableBudget6'); integer(hostMinimumRate6, 'hostMinimumRate6');
  integer(spareUnits, 'spareUnits');
  for (const k of ['anchorRate6', 'maximumRate6', 'maximumJobSpend6', 'maxObservationAgeSec',
    'quoteTtlSec', 'minimumDurationSec', 'maximumDurationSec', 'maxChangePpmPerHour']) integer(policy[k], k, true);
  integer(policy.minimumMultiplierPpm, 'minimumMultiplierPpm');
  integer(policy.maximumMultiplierPpm, 'maximumMultiplierPpm', true);
  if (policy.minimumMultiplierPpm > SCALE || policy.maximumMultiplierPpm < SCALE
      || policy.maximumDurationSec < policy.minimumDurationSec) throw new Error('invalid pricing bounds');
  for (const k of ['atSec', 'windowSec', 'paidDemandUnits', 'qualifiedSupplyUnits'])
    integer(observation[k], k, k === 'windowSec');
  if (typeof observation.classId !== 'string' || !observation.classId) throw new Error('resource class required');
  const decline = reason => ({ accepted: false, reason });
  if (policy.enabled !== true) return decline('disabled');
  if (policy.classId !== observation.classId) return decline('different resource class');
  if (observation.atSec > nowSec || nowSec - observation.atSec > policy.maxObservationAgeSec)
    return decline('stale observation');
  if (durationSec < policy.minimumDurationSec || durationSec > policy.maximumDurationSec)
    return decline('duration outside policy');
  if (observation.qualifiedSupplyUnits === 0n || spareUnits === 0n)
    return decline('no qualified spare capacity');
  if (availableBudget6 === 0n) return decline('no authorized budget');

  // Quadratic scarcity response, clipped BEFORE multiplication. At equal
  // demand/supply the multiplier is 1; examples: 1/2 -> 1/4, 2 -> 4.
  const ratioPpm = min(observation.paidDemandUnits * SCALE / observation.qualifiedSupplyUnits,
    policy.maximumMultiplierPpm + SCALE);
  const multiplierPpm = min(policy.maximumMultiplierPpm,
    max(policy.minimumMultiplierPpm, ratioPpm * ratioPpm / SCALE));
  let rate6 = min(policy.maximumRate6, policy.anchorRate6 * multiplierPpm / SCALE);
  if (previous) {
    integer(previous.atSec, 'previous.atSec'); integer(previous.rate6, 'previous.rate6');
    integer(previous.windowSec, 'previous.windowSec', true);
    if (previous.classId !== observation.classId || previous.windowSec !== observation.windowSec || previous.atSec >= observation.atSec)
      return decline('out of order or different class');
    // Relative to the fixed class anchor, not a repeatedly compounded quote.
    const change6 = policy.anchorRate6 * policy.maxChangePpmPerHour
      * (observation.atSec - previous.atSec) / (SCALE * 3600n);
    rate6 = min(max(rate6, previous.rate6 > change6 ? previous.rate6 - change6 : 0n),
      previous.rate6 + change6, policy.maximumRate6);
  }
  rate6 = min(rate6, min(availableBudget6, policy.maximumJobSpend6) / durationSec);
  if (rate6 === 0n) return decline('budget or rate below settlement precision');
  if (rate6 < hostMinimumRate6) return decline('below host minimum');
  const validUntilSec = min(nowSec + policy.quoteTtlSec, observation.atSec + policy.maxObservationAgeSec);
  if (validUntilSec <= nowSec) return decline('stale observation');
  return { accepted: true, classId: observation.classId, atSec: observation.atSec,
    rate6, maximumSpend6: rate6 * durationSec, durationSec, validUntilSec, windowSec: observation.windowSec,
    multiplierPpm, demandUnits: observation.paidDemandUnits, supplyUnits: observation.qualifiedSupplyUnits };
}
