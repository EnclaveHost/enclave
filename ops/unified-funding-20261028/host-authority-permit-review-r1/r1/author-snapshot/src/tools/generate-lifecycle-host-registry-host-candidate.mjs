// host-registry r2 (repair r1) strict hash-pinned ADDITIVE generator for the three Host composition files of
// lifecycle-schema3-host-composition-r1:
//   network/lifecycle-host-profile.mjs    98e33cfe...  exact 'independent-host-registry-r1' + registry artifact identity + the pure
//                                                      HOST INCARNATION context (exact uint64 generation, digest, validation)
//   network/lifecycle-host-authority.mjs  6baf5b55...  composer: registry === hostOwnership pins, adapter registry identity; admission
//                                                      binds owner/revision/policy, canonical Online AND the exact host incarnation
//   network/lifecycle-host-dispatch.mjs   3e826b74...  route/binding registry identity; durable incarnation floor + per-app binding
//                                                      persisted before effects; fences serve/start on any other incarnation;
//                                                      submit-boundary recheck before broadcasting a Running transition;
//                                                      explicit owner adoption of the exact current incarnation (fresh read)
// Insertions only; each output self-proves byte-for-byte restoration of its pinned input (insertion-patch.mjs). independent-r1 and
// independent-schema3-r1 are untouched: every behavioral insertion is guarded by the exact new profile (HR / hostRegistryKeys).
// Repair r1: the profile input SHA had one dropped hex digit (63 chars; root ROOT-DELTA.json) and the old marker
// HOST_REGISTRY_PROFILE did not occur in the dispatch output (root ROOT-MARKER-DELTA.txt). The marker is now the comment
// 'host-registry r2', present in all three outputs and absent from all three pinned inputs. No hash check is weakened.
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
for (const [f, h] of Object.entries(HOST_INPUT_SHA256)) if (!/^[0-9a-f]{64}$/.test(h)) throw Error(`pinned input hash for ${f} is not 64 hex characters`);
export const MARKER = 'host-registry r2';

export const PROFILE_EDITS = Object.freeze([
  { name: 'constants',
    before: "export const SCHEMA3_BUNDLE_SHA256 = 'bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';\n",
    after: 'export function hostProfile(profile) {',
    text: `// host-registry r2: schema3 + the canonical EnclaveHostLifecycleRegistry as BOTH registry and hostOwnership (one address, one runtime).
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
  else throw Error(\`\${what} is not an exact integer in the supported range\`);
  if (n < 0n || n > UINT64_MAX) throw Error(\`\${what} is outside uint64\`);
  return n.toString();
}
const opt32 = (v, what) => { if (v === undefined || v === null) return null; const x = String(v).toLowerCase(); if (!HEX32.test(x)) throw Error(\`\${what} malformed\`); return x; };
export const hostIncarnationDigest = x => '0x' + createHash('sha256').update(JSON.stringify(DIGEST_KEYS.map(k => [k, x[k]]))).digest('hex');
/** canonical host lifecycle of an adapter snapshot -> frozen exact incarnation. Throws (unknown) unless Online/Offline and well formed. */
export function hostIncarnationOf(L, { hostId, registryCodeHash = null } = {}) {
  if (!L || typeof L !== 'object') throw Error('canonical host lifecycle missing: host incarnation unknown');
  if (L.status !== 'online' && L.status !== 'offline') throw Error(\`canonical host status \${String(L.status)} has no incarnation\`);
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
  { name: 'import', before: 'import { schema3Binding', after: " } from './lifecycle-host-profile.mjs';",
    text: ', hostRegistryKeys, HOST_INCARNATION_FNS, validateHostIncarnation' },
  { name: 'binding-keys', before: "  exactKeys(b, s3 ? [...BINDING_KEYS, 'profile', 'bundleSha256'", after: "] : BINDING_KEYS, 'lifecycle chain binding');",
    text: ', ...hostRegistryKeys(b)' },
  { name: 'route-keys', before: "    exactKeys(r, s3 ? [...ROUTE_KEYS, 'profile', 'bundleSha256'", after: '] : ROUTE_KEYS, what);', text: ', ...hostRegistryKeys(binding)' },
  { name: 'route-identity',
    before: '      throw Error(`${what}: profile or bundle differs from the exact chain binding`);\n',
    after: '    if (!ID.test(r.deployment))',
    text: '    if (hostRegistryKeys(binding).some(k => r[k] !== binding[k])) throw Error(`${what}: host registry identity differs from the exact chain binding`);   // host-registry r2\n' },
  { name: 'signature', before: "  verifyQuiescence, now = Date.now, random = Math.random, intervalMs = 5000, onMissing = 'throw'", after: ' } = {}) {',
    text: ", hostIncarnationGenesis = 'explicit'" },
  { name: 'missing',
    before: "  if (typeof verifyQuiescence !== 'function') missing.push('verifyQuiescence');\n",
    after: '  // Without the binding no route ledger can be checked',
    text: '  // host-registry r2: the exact profile requires the DURABLE host incarnation section of the owned journal (no in-memory substitute)\n' +
      '  const HR = hostRegistryKeys(chain?.binding).length > 0;\n' +
      '  if (HR) for (const f of HOST_INCARNATION_FNS) if (typeof journal?.[f] !== \'function\') missing.push(`journal.${f} (durable host incarnation)`);\n' +
      "  if (HR && hostIncarnationGenesis !== 'explicit') throw Error('hostIncarnationGenesis must be explicit; unknown imported runtimes require safe adoption');\n" },
  { name: 'incarnation',
    before: '    return r?.floor ? { revision: BigInt(r.floor.revision), owner: r.floor.owner, policyHash: r.floor.policyHash } : null;\n  }\n',
    after: '  function checkDecision(id, d) {',
    text: `  // ---- host-registry r2: durable HOST INCARNATION (canonical registry generation), distinct from the app assignment generation ----
  // Every app context is bound in the owned journal, BEFORE its start effect, to the exact incarnation it started (or was explicitly
  // adopted) under. Any other current incarnation fences serving and new starts while old work may exist: never inherited. A journal or
  // decision that cannot be read is unknown, never allow. Nothing here releases a local hold or rewrites a journaled intent.
  const incarnation = () => {
    const r = journal.readHostIncarnation(host.hostId);   // throws when unreadable
    return { floor: r?.floor ?? null, genesis: r?.genesis ?? null, bound: r?.bound ?? {} };
  };
  const oldWork = id => { const a = allocation(id); return !a.observed || a.physical || a.reserved || a.commitment; };
  function acceptIncarnation(d) {   // monotonic, persisted BEFORE use: lower generation = rollback, same generation other digest = equivocation
    const x = validateHostIncarnation(d.hostIncarnation, { hostId: host.hostId, registry: binding.hostRegistry, registryCodeHash: binding.hostRegistryCodeHash });
    journal.acceptHostIncarnation(host.hostId, x);
  }
  function incarnationRefusal(id, d) {
    try {
      const x = d?.hostIncarnation;
      if (!x) return 'host incarnation unknown';
      const st = incarnation(), b = st.bound[id];
      if (!st.floor || st.floor.digest !== x.digest || st.floor.generation !== x.generation) return \`host incarnation \${x.generation} is not the durable accepted floor\`;
      if (b && b.digest === x.digest) return null;
      if (!oldWork(id)) return null;   // nothing of an older context can exist: a NEW start binds the current incarnation
      if (b) return \`app context bound to host generation \${b.generation}, canonical host is now generation \${x.generation}: fenced until stopped or explicitly adopted\`;
      return 'running app context has no recorded host incarnation: unknown until explicitly adopted';
    } catch (e) { return \`host incarnation journal unknown: \${msg(e)}\`; }
  }
  function bindIncarnation(id, d, why) {
    const x = d.hostIncarnation;
    if (incarnation().bound[id]?.digest === x.digest) return;
    journal.bindHostIncarnation(host.hostId, id, { generation: x.generation, digest: x.digest, reason: why, at: now() });
  }
  function incarnationGate(id, d) {   // read time: a mismatch is UNKNOWN (fences serve/start, the runner keeps reconciling and revoking)
    const why = incarnationRefusal(id, d);
    if (why) return why;
    return null;
  }
  // A FRESH authenticated read + decision of this route (adapter: code/schema/closure at its block); cached decisions never count.
  async function freshDecision(id, what) {
    const r = table.get(id), s = await chain.read(id);
    if (!s || s.id !== id || s.ledger !== r.newLedger || s.controller !== r.controller || s.thisHost !== host.hostId || s.verified !== true)
      throw Error(\`\${what}: no verified snapshot of this route\`);
    return checkDecision(id, await authority.decision(id, s));
  }
  // Immediately before a Running transition is BROADCAST: exact Online status, durable floor and the app binding at a fresh read.
  // Refusal here is sender-side no-effect; the journaled intent stays for read-only resolution.
  async function submitBoundary(id) {
    const d = await freshDecision(id, 'running submission refused before broadcast'), b = incarnation().bound[id];
    const why = denial(id, d) ?? (d.hostIncarnation.status !== 'online' ? \`canonical host is \${d.hostIncarnation.status}\` : null) ??
      (b?.digest !== d.hostIncarnation.digest ? \`the prepared start is not bound to current host generation \${d.hostIncarnation.generation}\` : null);
    if (why) throw Error(\`running submission refused before broadcast: \${why}\`);
  }
` },
  { name: 'decision-keys', before: '    exactKeys(d, DECISION_KEYS', after: ", 'host admission decision');", text: ".concat(HR ? ['hostIncarnation'] : [])" },
  { name: 'decision-accept',
    before: '    if (!floor || rev > floor.revision) journal.acceptHostAuthority(host.hostId, { revision: d.revision, owner: d.owner, policyHash: d.policyHash });\n',
    after: '    return Object.freeze({ ...d, platformOwned: platform.includes(d.owner) });',
    text: '    if (HR) acceptIncarnation(d);   // host-registry r2\n' },
  { name: 'serve-incarnation',
    before: '    if (ctx.unknown) return ctx.unknown;\n',
    after: "    if (!ctx.decision || ctx.decision.validUntil <= now()) return 'host admission expired';",
    text: '    if (HR) { const w = incarnationRefusal(id, ctx.decision); if (w) return w; }   // host-registry r2: re-checked at every serve/start\n' },
  { name: 'start-bind',
    before: '    if (why) throw Error(`lifecycle start refused: ${why}`);\n',
    after: '    const a = allocation(id), need = checkedShares(id, snapshot.resources);',
    text: "    if (HR) bindIncarnation(id, active.get(id).decision, 'new start');   // host-registry r2: persisted BEFORE the start effect\n" },
  { name: 'read-invalidate',
    before: "        if (!r) throw Error('no lifecycle route');\n",
    after: '        const s = await chain.read(id);',
    text: '        if (HR) decisions.delete(id);   // host-registry r2: an unknown/failed read leaves NO previous decision usable (ingress, adoption)\n' },
  { name: 'read-gate',
    before: '        try { ctx.decision = checkDecision(id, await authority.decision(id, s)); ctx.unknown = null; decisions.set(id, ctx.decision);',
    after: ' }\n        catch (e) { ctx.decision = null;',
    text: ' if (HR) ctx.unknown = incarnationGate(id, ctx.decision);' },
  { name: 'submit-boundary', before: '      submit: (id, intent) => ', after: 'chain.submit(id, intent),\n    };',
    text: 'HR && runningIntent(intent) ? submitBoundary(id).then(() => chain.submit(id, intent)) : ' },
  { name: 'serve-context',
    before: 'if (why) throw Error(`lifecycle serving refused: ${why}`); return runtime.serve(id, ',
    after: 'snapshot); },',
    text: 'HR ? Object.freeze({ ...snapshot, hostIncarnation: active.get(id).decision.hostIncarnation }) : ' },
  { name: 'adopt',
    before: '      return { released, epoch: at };\n    },\n',
    after: '    /** null, or why NO new work',
    text: `    /**
     * host-registry r2: the box owner's EXPLICIT adoption (authenticated local hosting-admin path, like restrict) of an existing app context
     * into the exact CURRENT Online host incarnation, named by decimal generation and digest. It takes its OWN fresh authenticated read
     * (an unknown chain refuses), needs an unrefused decision, the durable floor and no local hold, and fences old-context serving before
     * the durable rebinding. Never automatic; never a platform decision over a foreign host.
     */
    async adoptHostIncarnation(id, { generation, digest } = {}) {
      id = String(id || '').toLowerCase();
      if (!HR) throw Error('host incarnation adoption exists only in the host-registry profile');
      if (!host || !runner || !table.has(id) || !activated.has(id)) throw Error('lifecycle route not activated');
      if (inflight.has(id)) throw Error('host adoption cannot overlap reconciliation or another adoption');
      const startingEpoch = epoch(id);
      const stableLocal = () => {
        if (epoch(id) !== startingEpoch || localHolds.get(id)) throw Error('owner controls changed or hold remains during adoption');
        const row = journal.read(id);
        if (row.pending || (row.minedTransitions || []).length) throw Error('pending or nonfinal app transition must be reconciled before adoption');
      };
      const named = () => Error('adoption must name the exact current Online host incarnation (decimal generation and digest)');
      if (typeof generation !== 'string' || !/^0x[0-9a-f]{64}$/.test(digest || '')) throw named();
      let p;
      p = (async () => {
        stableLocal();
        const d = await freshDecision(id, 'adoption refused'), x = d.hostIncarnation, why = denial(id, d);
        if (why) throw Error(\`adoption refused: \${why}\`);
        if (x.status !== 'online' || generation !== x.generation || digest !== x.digest) throw named();
        stableLocal();
        await runtime.fence(id);
        if (await runtime.stop(id) !== true) throw Error('adoption refused: old runtime stop not confirmed');
        if (await inventory.findByName(id)) throw Error('adoption refused: old runtime still present');
        // A confirmed manager absence releases physical allocation, never a pending financial commitment.
        retired(id);
        stableLocal();
        const current = await freshDecision(id, 'adoption final read refused'), y = current.hostIncarnation;
        stableLocal();
        const finalWhy = denial(id, current);
        if (finalWhy) throw Error(\`adoption refused: \${finalWhy}\`);
        if (y.status !== 'online' || y.generation !== generation || y.digest !== digest ||
            current.owner !== d.owner || current.revision !== d.revision || current.policyHash !== d.policyHash)
          throw Error('host incarnation or accepted owner authority changed during adoption');
        const st = incarnation();
        if (!st.floor || st.floor.digest !== digest) throw Error('named incarnation is not the durable current floor');
        bindIncarnation(id, current, 'explicit owner adoption after confirmed runtime quiescence');
        say(\`\${id.slice(0, 10)} adopted into host generation \${generation} after confirmed stop\`);
        return Object.freeze({ adopted: true, generation, digest });
      })().finally(() => { if (inflight.get(id) === p) inflight.delete(id); });
      inflight.set(id, p);
      return p;
    },
` },
  { name: 'ingress', before: "      if (!d || d.validUntil <= now()) return 'host admission not fresh';\n", after: '      return denial(id, d);\n    },\n    start(',
    text: '      if (HR) { const w = denial(id, d) ?? incarnationRefusal(id, d); if (w) return w; }   // host-registry r2\n' },
  { name: 'state',
    before: '        hostAuthority: d ? { owner: d.owner, revision: d.revision, platformOwned: d.platformOwned, refusal: d.refusal } : null,\n',
    after: '        settlement:',
    text: '        ...(HR ? { hostIncarnation: d?.hostIncarnation ?? null } : {}),   // host-registry r2\n' },
]);

export const AUTHORITY_EDITS = Object.freeze([
  { name: 'import', before: 'import { hostProfile, SCHEMA3_HOST_PROFILE', after: " } from './lifecycle-host-profile.mjs';",
    text: ', HOST_REGISTRY_PROFILE, hostRegistryPinRefusals, hostIncarnationOf' },
  { name: 'admission-signature', before: 'export function createSnapshotHostAdmission({ hostId, profile = INDEPENDENT_PROFILE, now = Date.now', after: ' }) {',
    text: ', hostRegistry = null' },
  { name: 'admission',
    before: "      if (refusal !== null && (typeof refusal !== 'string' || !refusal)) throw Error('host owner refusal malformed');\n",
    after: '      return { hostId, deployment: id, owner: a.owner',
    text: `      let hostIncarnation = null;   // host-registry r2: the exact canonical host incarnation is part of the decision
      if (selected.hostRegistryArtifactSha256 !== undefined) {   // owner/revision/policy AND status/generation from the ONE canonical registry
        const L = s.hostLifecycle;
        if (!L || L.owner !== a.owner || L.revision !== a.revision || L.policyHash !== a.policyHash)
          throw Error('canonical host registry lifecycle/authority unavailable or inconsistent at the authenticated block');
        if (hostRegistry && String(L.registry).toLowerCase() !== hostRegistry.address) throw Error('canonical host lifecycle is from another registry');
        hostIncarnation = hostIncarnationOf(L, { hostId, registryCodeHash: hostRegistry?.codeHash ?? null });
        if (L.status !== 'online') return { hostId, deployment: id, owner: a.owner, revision: a.revision, policyHash: a.policyHash,
          refusal: \`canonical host registry is \${L.status} (generation \${hostIncarnation.generation}): no new start or serving\`, validUntil: now() + DECISION_MS, hostIncarnation };
      }
` },
  { name: 'admission-return', before: 'refusal, validUntil: now() + DECISION_MS', after: ' };\n    },\n  };\n}', text: ', ...(hostIncarnation ? { hostIncarnation } : {})' },
  { name: 'compose-signature', before: "  capacityHeadroom, verifyQuiescence, now = Date.now, intervalMs, onMissing = 'throw'", after: ' } = {}) {',
    text: ", hostIncarnationGenesis = 'explicit'" },
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
    text: "      if (HR && s && (String(s.hostLifecycle?.registry || '').toLowerCase() !== lower(C.registry.address) || (s.hostLifecycle.verified === true && s.verified !== true)))\n" +
      "        throw Error('host-registry route received a snapshot without the pinned canonical registry lifecycle (or a nested verified claim without authority)');\n" },
  { name: 'authority-registry', before: '  const authority = usable ? createSnapshotHostAdmission({ hostId, profile:selected.profile', after: ', now }) : undefined;',
    text: ', ...(HR ? { hostRegistry: { address: lower(C.registry.address), codeHash: C.registry.codeHash } } : {})' },
  { name: 'forward', before: '    platformWallets, capacityHeadroom, verifyQuiescence, now, onMissing,', after: ' ...(intervalMs ? { intervalMs } : {}) });',
    text: ' hostIncarnationGenesis,' },
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
