// The app expectation a Windows (Enclave Shield) host's privacy agent pins for one leased deployment, from the node
// manager's record of the partition it launched: shared by the platform's SSH reconcile (reconcile-shield-apps.mjs) and
// the host's own enrollment (windows/node/tuna-enroll.mjs), so both pin exactly the same thing.
//
// A record is used only when it is running and ready, names the lease's CURRENT catalog app and version, carries that
// version's catalog CID (and, for a raw-leaf CID, a component sha256 equal to the CID's digest), and runs the runtime the
// agent's admitted Shield policy pins; so a partition from before an upgrade is never pinned. The agent still verifies
// every proof against the policy itself, and the relay derives its own expectation from the chain before it routes.
const V5 = 'enclave-catalog-bundle/5', V6 = 'enclave-catalog-bundle/6', V7 = 'enclave-catalog-bundle/7';
const HEX64 = /^[0-9a-f]{64}$/;
// a raw-leaf CIDv1 (bafkrei...) is the sha256 of the bytes themselves
export const rawDigest = cid => {
  if (!/^bafkrei[a-z2-7]{52}$/.test(cid)) return null;
  let bits = 0, v = 0; const out = [];
  for (const ch of cid.slice(1)) { v = (v << 5) | 'abcdefghijklmnopqrstuvwxyz234567'.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out).subarray(4).toString('hex');
};
/** The catalog reference of a lease's appRef, or null. */
export const catalogRef = appRef => { const m = String(appRef || '').match(/^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/i); return m ? { app: m[1].toLowerCase(), version: Number(m[2]) } : null; };
/**
 * shieldExpectation({ row, version, vms, policy, previous }) -> { expected } | { wait } | { skip }:
 * row = the ledger deployment (id, appRef, configCid), version = its catalog version record ({ cid }), vms = the
 * manager's /vms list, policy = the admitted Shield policy, previous = the expectation pinned before (or null).
 */
export function shieldExpectation({ row, version, vms, policy, previous = null }) {
  const id = String(row.id).toLowerCase(), appRef = String(row.appRef), ref = catalogRef(appRef);
  if (!ref) return { skip: `appRef ${appRef} is not a catalog reference` };
  const vm = vms.filter(v => String(v.name).toLowerCase() === id && v.status === 'running' && v.appReady === true && !v.launching &&
      String(v.catalog?.app).toLowerCase() === ref.app && Number(v.catalog?.version) === ref.version && v.cid === String(version?.cid))
    .sort((x, y) => Number(y.startedAt) - Number(x.startedAt))[0];
  if (!vm) return { wait: `no ready partition runs ${appRef} yet` };
  const profile = Number(vm.gpuMilli) > 0 ? policy.gpu : policy.cpu, digest = rawDigest(vm.cid);
  const ports = vm.derivation === V7, secrets = vm.derivation === V6 || ports, bundle = secrets || vm.derivation === V5;
  if (!HEX64.test(vm.appId || '') || !profile?.runtimeId || vm.runtimeId !== profile.runtimeId || (digest && digest !== vm.componentSha256) ||
      (bundle && profile.configBundleV5 !== true) || (ports && (profile.protectedPorts !== true || profile.configSocketServer !== true)) ||
      (secrets && (profile.secretsV1 !== true || String(vm.secretDeployment).toLowerCase() !== id)))
    return { skip: "the manager's record is outside the admitted Shield policy" };
  return { expected: { appRef, configCid: String(row.configCid), appSha256: vm.appId, runtimeId: vm.runtimeId, requiresConfigBundleV5: bundle,
    requiresSecretsV1: secrets, ...(ports || (bundle && previous?.requiresConfigSocketServer === true) ? { requiresConfigSocketServer: true } : {}) } };
}
