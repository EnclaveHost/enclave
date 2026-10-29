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
  // THE CAP THAT BINDS. Hyper-V's root scheduler (Windows client hosts, scheduler type 0x4) does not enforce a VM's
  // processor Limit/Reservation (Microsoft's "VM CPU resource controls and the root scheduler"; on the NucBox a sustained
  // burn ran as fast at 16% as at 100% of its VP), so the VP count and those settings only SHAPE the VM. What confines the
  // app is its guest cgroup quota, cpu.max in percent of one processor: the purchased entitlement exactly, rounded DOWN
  // (never past what was bought; exact for whole-percent shares of a whole pool: 1% of 16 = 16, 21% = 336), applied
  // below the catalog's default cpuPercent too. The guest monitor states what it applied, and the launcher serves
  // nothing else (ENCLAVE_GUEST_CPU_ALLOWANCE=1). It is at least 1 (CPU_MIN_LIMIT) and at most vcpus * 100.
  const appCpuPercent = Math.floor(entitlementUnits / 1000);
  return { rule: "cpu-share", poolVcpus, cpuShare, entitlementUnits, vcpus, limit, reservation: limit, grantedUnits,
           policy: { vcpus: minVcpus, cpuPercent }, appCpuPercent };
}

/** The fixed legacy policy, for the synthetic readiness witness and for managers with no pools (labs). */
export function cpuFixedPolicy(policy, rule) {
  const vcpus = policy?.vcpus;
  if (!Number.isSafeInteger(vcpus) || vcpus <= 0) throw new Error("the app has no valid catalog CPU policy");
  return { rule, vcpus, limit: CPU_UNITS_PER_VCPU, reservation: 0, grantedUnits: vcpus * CPU_UNITS_PER_VCPU };
}
