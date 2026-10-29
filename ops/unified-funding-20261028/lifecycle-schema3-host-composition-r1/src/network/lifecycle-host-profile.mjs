// Explicit supported host compositions. These labels do not authenticate chain reads:
// the injected adapter still verifies the whole recursive contract graph at one block.
export const SCHEMA3_HOST_PROFILE = 'independent-schema3-r1';
export const SCHEMA3_BUNDLE_SHA256 = 'bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';
export function hostProfile(profile) {
  if (profile === 'independent-r1') return Object.freeze({profile,lifecycleSchema:2});
  if (profile === SCHEMA3_HOST_PROFILE) return Object.freeze({profile,lifecycleSchema:3,lifecycleProofSchema:2,bundleSha256:SCHEMA3_BUNDLE_SHA256});
  throw Error('unsupported exact independent host profile');
}
export function schema3Binding(binding) {
  if (binding?.profile === undefined) {
    if (binding?.lifecycleSchema !== 2 || Object.hasOwn(binding ?? {},'bundleSha256'))
      throw Error('schema2 binding required when explicit schema3 profile is absent');
    return false;
  }
  if (binding.profile !== SCHEMA3_HOST_PROFILE || binding.lifecycleSchema !== 3 || binding.bundleSha256 !== SCHEMA3_BUNDLE_SHA256)
    throw Error('schema3 binding requires the exact reviewed profile, schema and compiler bundle');
  return true;
}
