// Host reservation policy, not an attested capacity measurement. The measured
// guest refuses to create its desktop cgroup unless the RAM its kernel reports
// is at least app + 512 MiB (isolation/m3/desktop CheckCapacity), so the
// partition is the app's RAM plus what never reaches that figure:
//   512 MiB  the guest's own platform reserve (its check)
//  1024 MiB  the most a guest kernel sets aside for bounce buffers
//   256 MiB  VTL2, the paravisor and firmware (215 seen on a 2048 MiB partition)
//     2 %    the kernel's page array and tables, which grow with the partition
// Until 2026-11-25 the rule was align2(appMiB * 3 / 2): 12 GiB held idle beside
// a 24-GiB desktop on nucbox-k11-4. A partition this rule sizes too small is
// refused by the guest at launch; it never runs with less than its app RAM.
// The manager must reserve ALL vmMiB.
export const DESKTOP_RESERVE_MIB = 512 + 1024 + 256;
export const DESKTOP_MEMORY_RULE = 'align2((appMiB + 1792) * 1.02), guest capacity checked before launch';
// Explicit installed sidecar policy: only its exact 24-GiB allowance uses a
// 32-GiB partition (qualified before the general rule was tightened; kept as
// installed). It is not fresh capacity proof or a change to other hosts.
export const NATIVE_24G_MEMORY_PROFILE = 'native-24g-in-32g-v1';
export function desktopVmMemMiB(appMiB, profile = null) {
  if (profile !== null && profile !== NATIVE_24G_MEMORY_PROFILE) throw new Error('unknown desktop memory profile');
  if (!Number.isSafeInteger(appMiB) || appMiB < 8192 || appMiB > 65536)
    throw new Error('native desktop app memory must be 8192..65536 MiB');
  if (profile === NATIVE_24G_MEMORY_PROFILE && appMiB === 24576) return 32768;
  return Math.ceil(Math.ceil((appMiB + DESKTOP_RESERVE_MIB) * 1.02) / 2) * 2;
}
