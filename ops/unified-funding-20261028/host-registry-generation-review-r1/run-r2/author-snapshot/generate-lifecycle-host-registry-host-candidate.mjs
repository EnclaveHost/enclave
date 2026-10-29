// host-registry r2 strict hash-pinned ADDITIVE generator for the three Host composition files of lifecycle-schema3-host-composition-r1:
//   network/lifecycle-host-profile.mjs    98e33cfe...  explicit 'independent-host-registry-r1' + exact registry artifact identity
//   network/lifecycle-host-authority.mjs  6baf5b55...  composer: registry === hostOwnership pins, adapter registry identity, admission
//                                                      owner/revision/policy and canonical Online from the one registry snapshot
//   network/lifecycle-host-dispatch.mjs   3e826b74...  finite route manifests/binding carry the exact registry identity
// Insertions only; each output self-proves byte-for-byte restoration of its pinned input (insertion-patch.mjs). independent-r1 and
// independent-schema3-r1 are untouched: every insertion is guarded by the exact new profile (or adds only keys it requires).
//
//   node generate-lifecycle-host-registry-host-candidate.mjs <abs input src/network dir> <abs output dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyInsertions, sha256 } from
  '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/lifecycle-schema3-host-composition-r1/src/tools/insertion-patch.mjs';

export const HOST_INPUT_SHA256 = Object.freeze({
  'lifecycle-host-profile.mjs': '98e33cfeb1b7612d49e8a30260d8272b8863808f558971f0c68a798c965d9176',
  'lifecycle-host-authority.mjs': '6baf5b55210c5e4273dc0e797fcadb3f691d6eafae201dd46b4ab59a1919ea92',
  'lifecycle-host-dispatch.mjs': '3e826b743e3a0a6db91908a8db54159764902746b6133fd1987357bd73d8b57b' });
const MARKER = 'HOST_REGISTRY_PROFILE';

export const PROFILE_EDITS = Object.freeze([
  { name: 'constants',
    before: "export const SCHEMA3_BUNDLE_SHA256 = 'bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';\n",
    after: 'export function hostProfile(profile) {',
    text: `// host-registry r2: schema3 + the canonical EnclaveHostLifecycleRegistry as BOTH registry and hostOwnership (one address, one runtime).
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
` },
  { name: 'host-profile',
    before: '  if (profile === SCHEMA3_HOST_PROFILE) return Object.freeze({profile,lifecycleSchema:3,lifecycleProofSchema:2,bundleSha256:SCHEMA3_BUNDLE_SHA256});\n',
    after: "  throw Error('unsupported exact independent host profile');",
    text: '  if (profile === HOST_REGISTRY_PROFILE) return Object.freeze({profile,lifecycleSchema:3,lifecycleProofSchema:2,bundleSha256:SCHEMA3_BUNDLE_SHA256,\n' +
      '    hostRegistryArtifactSha256:HOST_REGISTRY_ARTIFACT_SHA256});\n' },
  { name: 'binding',
    before: '    return false;\n  }\n',
    after: '  if (binding.profile !== SCHEMA3_HOST_PROFILE ||',
    text: '  if (binding.profile === HOST_REGISTRY_PROFILE) {   // host-registry r2: schema3 shape + exact registry identity\n' +
      "    if (binding.lifecycleSchema !== 3 || binding.bundleSha256 !== SCHEMA3_BUNDLE_SHA256) throw Error('host-registry binding requires schema3 and the exact reviewed compiler bundle');\n" +
      '    validateHostRegistryBinding(binding);\n    return true;\n  }\n' },
]);

export const DISPATCH_EDITS = Object.freeze([
  { name: 'import', before: 'import { schema3Binding', after: " } from './lifecycle-host-profile.mjs';", text: ', hostRegistryKeys' },
  { name: 'binding-keys', before: "  exactKeys(b, s3 ? [...BINDING_KEYS, 'profile', 'bundleSha256'", after: "] : BINDING_KEYS, 'lifecycle chain binding');",
    text: ', ...hostRegistryKeys(b)' },
  { name: 'route-keys', before: "    exactKeys(r, s3 ? [...ROUTE_KEYS, 'profile', 'bundleSha256'", after: '] : ROUTE_KEYS, what);', text: ', ...hostRegistryKeys(binding)' },
  { name: 'route-identity',
    before: '      throw Error(`${what}: profile or bundle differs from the exact chain binding`);\n',
    after: '    if (!ID.test(r.deployment))',
    text: '    if (hostRegistryKeys(binding).some(k => r[k] !== binding[k])) throw Error(`${what}: host registry identity differs from the exact chain binding`);   // host-registry r2\n' },
]);

export const AUTHORITY_EDITS = Object.freeze([
  { name: 'import', before: 'import { hostProfile, SCHEMA3_HOST_PROFILE', after: " } from './lifecycle-host-profile.mjs';", text: ', HOST_REGISTRY_PROFILE, hostRegistryPinRefusals' },
  { name: 'admission',
    before: "      if (refusal !== null && (typeof refusal !== 'string' || !refusal)) throw Error('host owner refusal malformed');\n",
    after: '      return { hostId, deployment: id, owner: a.owner',
    text: `      if (selected.hostRegistryArtifactSha256 !== undefined) {   // host-registry r2: owner/revision/policy AND Online from the ONE canonical registry
        const L = s.hostLifecycle;
        if (!L || L.verified !== true || L.owner !== a.owner || L.revision !== a.revision || L.policyHash !== a.policyHash)
          throw Error('canonical host registry lifecycle/authority unavailable or inconsistent at the authenticated block');
        if (L.status !== 'online') return { hostId, deployment: id, owner: a.owner, revision: a.revision, policyHash: a.policyHash,
          refusal: \`canonical host registry is \${L.status} (generation \${L.generation}): no new start or serving\`, validUntil: now() + DECISION_MS };
      }
` },
  { name: 'hr-pins',
    before: "  if (!ID.test(adapterPins?.host || '')) missing.push('adapterPins.host');\n",
    after: '  let selected;',
    text: '  const HR = adapterPins?.profile === HOST_REGISTRY_PROFILE;   // host-registry r2: exact profile only, never inferred\n' +
      '  if (HR) missing.push(...hostRegistryPinRefusals(adapterPins));\n' },
  { name: 's3', before: '  const s3 = selected?.profile === SCHEMA3_HOST_PROFILE', after: ';\n  if (s3 && adapterPins.chainId', text: ' || selected?.profile === HOST_REGISTRY_PROFILE' },
  { name: 'adapter-identity',
    before: "    missing.push('adapter.profile (schema3/proof2/exact reviewed bundle)');\n",
    after: '  const hostId = adapterPins.host',
    text: '  if (HR && (adapter?.hostRegistry?.artifactSha256 !== selected.hostRegistryArtifactSha256 || adapter.hostRegistry.address !== lower(C.registry.address) ||\n' +
      "      adapter.hostRegistry.runtimeCodeHash !== C.registry.codeHash)) missing.push('adapter.hostRegistry (exact reviewed registry artifact/address/runtime)');\n" },
  { name: 'binding',
    before: '    ...(s3 ? {profile:selected.profile,bundleSha256:selected.bundleSha256} : {})',
    after: ' };\n  const usable',
    text: ', ...(HR ? {hostRegistry:lower(C.registry.address),hostRegistryCodeHash:C.registry.codeHash,hostRegistryArtifactSha256:selected.hostRegistryArtifactSha256} : {})' },
  { name: 'read',
    before: "        throw Error('schema3 route received a mismatched profile/schema snapshot');\n",
    after: '      return s && { ...s, ledger, controller };',
    text: '      if (HR && s && (s.hostLifecycle?.verified !== true || s.hostLifecycle.registry !== lower(C.registry.address)))\n' +
      "        throw Error('host-registry route received a snapshot without the canonical lifecycle of the pinned registry');\n" },
]);

const EDITS = { 'lifecycle-host-profile.mjs': PROFILE_EDITS, 'lifecycle-host-authority.mjs': AUTHORITY_EDITS, 'lifecycle-host-dispatch.mjs': DISPATCH_EDITS };

/** { file -> text } -> { file -> { source, sha256, baselineSha256, manifest } }. Pure. */
export function generateHostRegistryHostFiles(inputs) {
  return Object.fromEntries(Object.entries(EDITS).map(([f, edits]) => [f,
    applyInsertions(inputs[f], { expectedSha256: HOST_INPUT_SHA256[f], edits, marker: MARKER, what: f })]));
}

export function writeHostRegistryHostFiles(inputDir, outputDir) {
  if (!path.isAbsolute(inputDir) || !path.isAbsolute(outputDir)) throw Error('absolute input and output directories required');
  const inReal = fs.realpathSync(inputDir), outReal = fs.realpathSync(outputDir);
  if (inReal === outReal) throw Error('the candidates must be written outside the input directory');
  const inputs = Object.fromEntries(Object.keys(EDITS).map(f => [f, fs.readFileSync(path.join(inReal, f), 'utf8')]));
  const r = generateHostRegistryHostFiles(inputs), out = {};
  for (const [f, x] of Object.entries(r)) {
    fs.writeFileSync(path.join(outReal, f), x.source, { flag: 'wx', mode: 0o644 });
    if (sha256(fs.readFileSync(path.join(inReal, f), 'utf8')) !== HOST_INPUT_SHA256[f]) throw Error(`${f} input changed during generation`);
    out[f] = { sha256: x.sha256, baselineSha256: x.baselineSha256, manifest: x.manifest };
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) { console.error('usage: generate-lifecycle-host-registry-host-candidate.mjs <input src/network dir> <output dir>'); process.exit(2); }
  console.log(JSON.stringify(writeHostRegistryHostFiles(input, output), null, 1));
}
