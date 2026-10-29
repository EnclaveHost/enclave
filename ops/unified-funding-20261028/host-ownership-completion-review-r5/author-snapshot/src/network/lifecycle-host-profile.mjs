// Explicit supported host compositions. These labels do not authenticate chain reads:
// the injected adapter still verifies the whole recursive contract graph at one block.
export const SCHEMA3_HOST_PROFILE = 'independent-schema3-r1';
export const SCHEMA3_BUNDLE_SHA256 = 'bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';
// host-registry r2: schema3 + the canonical EnclaveHostLifecycleRegistry as BOTH registry and hostOwnership (one address, one runtime).
// The artifact SHA is code identity for the route manifest; the adapter re-verifies runtime/schema/lifecycle at its authenticated block.
import { createHash } from 'node:crypto';
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
// host-registry r2 HOST INCARNATION: the canonical registry generation (with its qualification identity) that an app context runs
// under. It is NOT the per-app assignment generation. Generations are exact decimal strings; nothing is rounded.
const UINT64_MAX = 2n ** 64n - 1n, HEX32 = /^0x[0-9a-f]{64}$/, ADDR20 = /^0x[0-9a-f]{40}$/;
export const HOST_INCARNATION_FNS = Object.freeze(['readHostIncarnation', 'acceptHostIncarnation', 'bindHostIncarnation']);
export const HOST_INCARNATION_KEYS = Object.freeze(['profile', 'hostId', 'registry', 'registryCodeHash', 'generation', 'status', 'qualificationDigest',
  'trustAnchorId', 'hardwareId', 'resourceDigest', 'descriptorDigest', 'digest']);
const DIGEST_KEYS = HOST_INCARNATION_KEYS.filter(k => k !== 'status' && k !== 'digest');   // status changes within one incarnation (Offline)
/** exact uint64 -> canonical decimal string. A non-safe JS number, a fraction or anything outside uint64 is refused, never rounded. */
export function exactUint64(v, what) {
  let n;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v)) n = BigInt(v);
  else throw Error(`${what} is not an exact integer in the supported range`);
  if (n < 0n || n > UINT64_MAX) throw Error(`${what} is outside uint64`);
  return n.toString();
}
const opt32 = (v, what) => { if (v === undefined || v === null) return null; const x = String(v).toLowerCase(); if (!HEX32.test(x)) throw Error(`${what} malformed`); return x; };
export const hostIncarnationDigest = x => '0x' + createHash('sha256').update(JSON.stringify(DIGEST_KEYS.map(k => [k, x[k]]))).digest('hex');
/** canonical host lifecycle of an adapter snapshot -> frozen exact incarnation. Throws (unknown) unless Online/Offline and well formed. */
export function hostIncarnationOf(L, { hostId, registryCodeHash = null } = {}) {
  if (!L || typeof L !== 'object') throw Error('canonical host lifecycle missing: host incarnation unknown');
  if (L.status !== 'online' && L.status !== 'offline') throw Error(`canonical host status ${String(L.status)} has no incarnation`);
  const registry = String(L.registry || '').toLowerCase();
  if (!ADDR20.test(registry) || !HEX32.test(hostId || '')) throw Error('host incarnation registry/host malformed');
  const generation = exactUint64(L.generation, 'host generation');
  if (generation === '0') throw Error('host generation 0 is not an enrolled incarnation');
  const x = { profile: HOST_REGISTRY_PROFILE, hostId, registry, registryCodeHash: opt32(registryCodeHash, 'registry code hash'), generation, status: L.status,
    qualificationDigest: opt32(L.qualificationDigest, 'qualificationDigest'), trustAnchorId: opt32(L.trustAnchorId, 'trustAnchorId'),
    hardwareId: opt32(L.hardwareId, 'hardwareId'), resourceDigest: opt32(L.resourceDigest, 'resourceDigest'), descriptorDigest: opt32(L.descriptorDigest, 'descriptorDigest') };
  return Object.freeze({ ...x, digest: hostIncarnationDigest(x) });
}
/** A decision's incarnation, re-validated exactly against the dispatch's own pinned binding (never trusted as a label). */
export function validateHostIncarnation(x, { hostId, registry, registryCodeHash }) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw Error('decision.hostIncarnation required by the host-registry profile');
  const keys = Object.keys(x);
  if (keys.length !== HOST_INCARNATION_KEYS.length || HOST_INCARNATION_KEYS.some(k => !Object.hasOwn(x, k))) throw Error('decision.hostIncarnation has unknown or missing fields');
  if (x.profile !== HOST_REGISTRY_PROFILE || x.hostId !== hostId || x.registry !== registry || x.registryCodeHash !== registryCodeHash)
    throw Error('host incarnation binds another profile, host, registry or registry runtime');
  if (typeof x.generation !== 'string' || exactUint64(x.generation, 'host generation') !== x.generation || x.generation === '0' || !['online', 'offline'].includes(x.status))
    throw Error('host incarnation generation/status malformed');
  if (x.digest !== hostIncarnationDigest(x)) throw Error('host incarnation digest does not match its fields');
  return x;
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
