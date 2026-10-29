// Explicit supported host compositions. These labels do not authenticate chain reads:
// the injected adapter still verifies the whole recursive contract graph at one block.
export const SCHEMA3_HOST_PROFILE = 'independent-schema3-r1';
export const SCHEMA3_BUNDLE_SHA256 = 'bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';
// host-registry r2: schema3 + the canonical EnclaveHostLifecycleRegistry as BOTH registry and hostOwnership (one address, one runtime).
// The artifact SHA is code identity for the route manifest; the adapter re-verifies runtime/schema/lifecycle at its authenticated block.
export const HOST_REGISTRY_PROFILE = 'independent-host-registry-r1';
export const HOST_REGISTRY_ARTIFACT_SHA256 = 'e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a';
export const HOST_REGISTRY_BINDING_KEYS = Object.freeze(['hostRegistry', 'hostRegistryCodeHash', 'hostRegistryArtifactSha256']);
export const hostRegistryKeys = b => (b?.profile === HOST_REGISTRY_PROFILE ? HOST_REGISTRY_BINDING_KEYS : []);
export function validateHostRegistryBinding(b) {
  if (!/^0x[0-9a-f]{40}$/.test(b?.hostRegistry || '') || /^0x0{40}$/.test(b.hostRegistry) || !/^0x[0-9a-f]{64}$/.test(b.hostRegistryCodeHash || '') ||
      b.hostRegistryArtifactSha256 !== HOST_REGISTRY_ARTIFACT_SHA256)
    throw Error('host-registry binding requires the exact registry address, runtime code hash and reviewed artifact');
}
/** adapterPins -> refusals (empty when the pins name ONE canonical registry for both roles). Pure; labels never authenticate. */
export function hostRegistryPinRefusals(p) {
  const C = p?.contracts ?? {}, r = C.registry, o = C.hostOwnership, out = [];
  const addr = x => String(x?.address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr(r)) || !/^0x[0-9a-f]{64}$/.test(r?.codeHash || '')) out.push('adapterPins.contracts.registry (canonical host registry)');
  else if (addr(o) !== addr(r) || o?.codeHash !== r.codeHash) out.push('adapterPins.contracts.hostOwnership (must be the SAME canonical host registry)');
  if (p?.hostRegistry?.artifactSha256 !== HOST_REGISTRY_ARTIFACT_SHA256) out.push('adapterPins.hostRegistry.artifactSha256 (exact reviewed registry artifact)');
  return out;
}
export function hostProfile(profile) {
  if (profile === 'independent-r1') return Object.freeze({profile,lifecycleSchema:2});
  if (profile === SCHEMA3_HOST_PROFILE) return Object.freeze({profile,lifecycleSchema:3,lifecycleProofSchema:2,bundleSha256:SCHEMA3_BUNDLE_SHA256});
  if (profile === HOST_REGISTRY_PROFILE) return Object.freeze({profile,lifecycleSchema:3,lifecycleProofSchema:2,bundleSha256:SCHEMA3_BUNDLE_SHA256,
    hostRegistryArtifactSha256:HOST_REGISTRY_ARTIFACT_SHA256});
  throw Error('unsupported exact independent host profile');
}
export function schema3Binding(binding) {
  if (binding?.profile === undefined) {
    if (binding?.lifecycleSchema !== 2 || Object.hasOwn(binding ?? {},'bundleSha256'))
      throw Error('schema2 binding required when explicit schema3 profile is absent');
    return false;
  }
  if (binding.profile === HOST_REGISTRY_PROFILE) {   // host-registry r2: schema3 shape + exact registry identity
    if (binding.lifecycleSchema !== 3 || binding.bundleSha256 !== SCHEMA3_BUNDLE_SHA256) throw Error('host-registry binding requires schema3 and the exact reviewed compiler bundle');
    validateHostRegistryBinding(binding);
    return true;
  }
  if (binding.profile !== SCHEMA3_HOST_PROFILE || binding.lifecycleSchema !== 3 || binding.bundleSha256 !== SCHEMA3_BUNDLE_SHA256)
    throw Error('schema3 binding requires the exact reviewed profile, schema and compiler bundle');
  return true;
}
