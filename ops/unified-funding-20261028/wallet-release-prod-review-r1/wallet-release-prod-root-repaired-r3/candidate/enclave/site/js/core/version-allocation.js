import { liftSharesForLedger } from './pricing.js';

// A version change keeps existing reservations and buys only the shortfall.
// Free shares exclude this deployment, so compare the INCREASE, not the total.
export function versionAllocation({ bought, gpuPct, cpuMinimum, rev, maxGpu, availability }) {
  const gpuMilli = Math.max(bought.gpuMilli, gpuPct * 10);
  const cpuMilli = Math.max(bought.cpuMilli, Math.max(1, cpuMinimum(gpuMilli)) * 10);
  const lifted = liftSharesForLedger({ gpuPct: gpuMilli / 10, cpuPct: cpuMilli / 10 }, rev);
  const target = { gpuMilli: Math.round(lifted.gpuPct * 10), cpuMilli: Math.round(lifted.cpuPct * 10) };
  const resized = target.gpuMilli !== bought.gpuMilli || target.cpuMilli !== bought.cpuMilli;
  let reason = '';
  if (resized) {
    if (rev < 6) reason = 'This ledger does not support the allocation increase.';
    else if (target.gpuMilli > Math.min(1000, maxGpu) || target.cpuMilli > 1000)
      reason = 'The new version exceeds the allocation limit.';
    else for (const pool of ['gpu', 'cpu']) {
      const extra = target[pool + 'Milli'] - bought[pool + 'Milli'];
      if (extra <= 0) continue;
      const free = availability?.[pool + 'ShareFree'];
      if (typeof free !== 'number' || !Number.isFinite(free) || free < 0 || free > 1) {
        reason = 'Current ' + pool.toUpperCase() + ' capacity is unavailable. Reopen Version to retry.'; break;
      }
      if (extra > Math.floor(free * 1000 + 1e-7)) {
        reason = 'Needs ' + (extra / 10) + '% additional ' + pool.toUpperCase()
          + '; only ' + (Math.floor(free * 1000 + 1e-7) / 10) + '% is free on this host.'; break;
      }
    }
  }
  return { target, resized, reason };
}
