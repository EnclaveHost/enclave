// Draft allocations stay in ledger milli-shares, including fractional percents.
// Reading bounds never changes a saved allocation that is below a new minimum.
export function shareBounds(shares, { mins, maxGpu = 1000, rev = 13, cpuMinimum }, fallback = false) {
  const cpuMin = Math.max(10, Math.ceil(10 * (cpuMinimum ? cpuMinimum(shares.gpuMilli) :
    shares.gpuMilli > 0 ? mins.cpuPct : mins.cpuPctNoGpu)), fallback ? Math.ceil(mins.cpuPctNoGpu * 10) : 0);
  const coupled = rev < 13 && shares.gpuMilli > 0;
  return {
    cpuMin, cpuMax: coupled ? Math.min(1000, shares.gpuMilli) : 1000,
    gpuMin: Math.max(Math.ceil(mins.gpuPct * 10), coupled ? shares.cpuMilli : 0), gpuMax: maxGpu,
  };
}

export function changeShares(shares, pool, value, options, fallback = false) {
  const bounds = shareBounds(shares, options, fallback);
  const min = bounds[pool + 'Min'], max = bounds[pool + 'Max'];
  if (!Number.isFinite(value) || min > max) return { ...shares };
  const next = { ...shares, [pool + 'Milli']: Math.max(min, Math.min(max, Math.round(value))) };
  // Dropping an optional GPU can raise the CPU floor. Keep the draft valid
  // in that same gesture, or refuse the change if fallback cannot fit.
  const after = shareBounds(next, options, fallback);
  if (after.cpuMin > after.cpuMax || after.gpuMin > after.gpuMax) return { ...shares };
  next.cpuMilli = Math.max(after.cpuMin, Math.min(after.cpuMax, next.cpuMilli));
  next.gpuMilli = Math.max(after.gpuMin, Math.min(after.gpuMax, next.gpuMilli));
  return next;
}
