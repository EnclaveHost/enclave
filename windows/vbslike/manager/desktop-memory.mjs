// Host reservation policy, not an attested capacity measurement. The 8-GiB app
// / 12-GiB partition case booted on NucBox. The larger range is a conservative
// allocation policy; the measured guest separately checks app RAM + 512 MiB
// before creating its desktop cgroup. The manager must reserve ALL vmMiB.
export const DESKTOP_MEMORY_RULE = 'align2(appMiB * 3 / 2), guest capacity checked before launch';
// Explicit installed sidecar policy: only its exact 24-GiB allowance uses a
// 32-GiB partition. It is not fresh capacity proof or a change to other hosts.
export const NATIVE_24G_MEMORY_PROFILE = 'native-24g-in-32g-v1';
export function desktopVmMemMiB(appMiB, profile = null) {
  if (profile !== null && profile !== NATIVE_24G_MEMORY_PROFILE) throw new Error('unknown desktop memory profile');
  if (!Number.isSafeInteger(appMiB) || appMiB < 8192 || appMiB > 65536)
    throw new Error('native desktop app memory must be 8192..65536 MiB');
  if (profile === NATIVE_24G_MEMORY_PROFILE && appMiB === 24576) return 32768;
  return Math.ceil(appMiB * 3 / 4) * 2;
}
