// CPU allocation, like RAM (memory-share.mjs), is separate from the immutable catalog/attestation policy.
// Units are Hyper-V's own: Msvm_ProcessorSettingData Limit/Reservation in percent/1000 of ONE virtual processor,
// so 100000 is a whole VP. The share buys poolVcpus*share VPs' worth; the VP count only shapes it.
export const CPU_UNITS_PER_VCPU = 100000;
export const CPU_MIN_LIMIT = 1000;          // 1% of one VP: below this the cap is not a meaningful allocation
export const CPU_MAX_POOL_VCPUS = 1024;
export const CPU_WMI_UNITS = "percent / 1000";

export function validCpuPool(poolVcpus) {
  return Number.isSafeInteger(poolVcpus) && poolVcpus > 0 && poolVcpus <= CPU_MAX_POOL_VCPUS;
}

export function cpuForShare(poolVcpus, cpuShare, policy) {
  if (!validCpuPool(poolVcpus)) throw new Error("the manager has no valid CPU pool (NODE_VCPUS)");
  if (!Number.isFinite(cpuShare) || cpuShare <= 0 || cpuShare > 1)
    throw new Error("cpuShare must be greater than zero and at most one");
  const minVcpus = policy?.vcpus, cpuPercent = policy?.cpuPercent;
  if (!Number.isSafeInteger(minVcpus) || minVcpus <= 0 || !Number.isSafeInteger(cpuPercent) || cpuPercent <= 0)
    throw new Error("the app has no valid catalog CPU policy");
  const entitlementUnits = Math.floor(poolVcpus * cpuShare * CPU_UNITS_PER_VCPU + 1e-6);
  const vcpus = Math.max(minVcpus, Math.ceil(entitlementUnits / CPU_UNITS_PER_VCPU));
  if (vcpus > poolVcpus)
    throw new Error(`the app needs ${vcpus} virtual processors, but the CPU pool has ${poolVcpus}`);
  const limit = Math.floor(entitlementUnits / vcpus);
  if (limit < CPU_MIN_LIMIT)
    throw new Error(`CPU share allows ${entitlementUnits} units over ${vcpus} VP(s), below ${CPU_MIN_LIMIT} per VP`);
  const grantedUnits = vcpus * limit;
  // The measured guest monitor confines the app to cgroup cpu.max = catalog cpuPercent (EffectivePolicy: the
  // bundle wins), so the app itself can use no more than that, whatever the VM is given.
  const appCapUnits = cpuPercent * 1000;
  const realizableUnits = Math.min(grantedUnits, appCapUnits);
  return { rule: "cpu-share", poolVcpus, cpuShare, entitlementUnits, vcpus, limit, reservation: limit, grantedUnits,
           policy: { vcpus: minVcpus, cpuPercent }, appCapUnits, realizableUnits,
           blocker: realizableUnits < grantedUnits
             ? `the measured guest confines the app to its catalog cpuPercent ${cpuPercent} (cgroup cpu.max); `
               + `${grantedUnits - realizableUnits} of ${grantedUnits} granted units are not usable by the app until the guest honours a runtime CPU allowance`
             : null };
}

/** The fixed legacy policy, for the synthetic readiness witness and for managers with no pools (labs). */
export function cpuFixedPolicy(policy, rule) {
  const vcpus = policy?.vcpus;
  if (!Number.isSafeInteger(vcpus) || vcpus <= 0) throw new Error("the app has no valid catalog CPU policy");
  return { rule, vcpus, limit: CPU_UNITS_PER_VCPU, reservation: 0, grantedUnits: vcpus * CPU_UNITS_PER_VCPU };
}
