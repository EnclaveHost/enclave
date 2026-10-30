// Resource allocation is separate from the immutable catalog/attestation policy.
export function appMemoryForShare(poolMiB, cpuShare, minimumMiB) {
  if (!Number.isSafeInteger(poolMiB) || poolMiB <= 0)
    throw new Error("the manager has no valid advertised RAM pool");
  if (!Number.isFinite(cpuShare) || cpuShare <= 0 || cpuShare > 1)
    throw new Error("cpuShare must be greater than zero and at most one");
  if (!Number.isSafeInteger(minimumMiB) || minimumMiB <= 0)
    throw new Error("the app has no valid minimum RAM requirement");
  const appMiB = Math.floor(poolMiB * cpuShare + 1e-7);
  if (appMiB < minimumMiB)
    throw new Error(`CPU share allows ${appMiB} MiB RAM, but the app requires ${minimumMiB} MiB`);
  return { rule: "cpu-share", poolMiB, cpuShare, appMiB };
}
