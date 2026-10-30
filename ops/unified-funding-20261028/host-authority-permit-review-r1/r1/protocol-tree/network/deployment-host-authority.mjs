// host-authority permit r1 (SOURCE ONLY): the exact canonical HOST AUTHORITY of the 'independent-host-registry-r1' profile and the
// versioned ServingPermit v2 that binds it. Selected ONLY by explicit reviewed pins:
//   pins.servingPermit = { version: 2, profile: 'independent-host-registry-r1' }
// Absent -> v1: deployment-serving-permit.mjs behaves byte-for-byte as before (its v1 typed data, domain and checks are untouched).
//
// Four separate axes, never conflated:
//   app assignment generation (record.generation)      app policy revision (record.policyRevision)
//   HOST generation (hostAuthority.hostGeneration)      host OWNER revision (hostAuthority.ownerRevision)
// uint64 values travel as canonical decimal strings and are signed as uint64 (BigInt); nothing is rounded through Number.
//
// The context is EIP-712 nested inside the v2 ServingPermit (domain version '2-host-authority'), so every component changes the
// signed digest; a JSON field outside the typed data would NOT be a binding. Registry reporter keys are only hashed into the context
// (reporterPolicyDigest); they are never permit/app witness keys. Chain proof authority (`proofVerified`, from the authenticated
// snapshot boundary) is kept separate from code consistency; no nested `verified` flag is read or emitted.
import { getAddress, hashTypedData, keccak256, encodeAbiParameters } from 'viem';

export const HOST_AUTHORITY_VERSION = 'enclave-host-authority/v1';
export const HOST_AUTHORITY_PROFILE = 'independent-host-registry-r1';
export const SERVING_PERMIT_V2 = Object.freeze({ name: 'EnclaveServingPermit', version: '2-host-authority' });
const UINT64_MAX = 2n ** 64n - 1n, H32 = /^0x[0-9a-f]{64}$/, A20 = /^0x[0-9a-f]{40}$/, DEC = /^(0|[1-9][0-9]{0,19})$/;
const HOST_AUTHORITY_TYPE = [
  { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint64' }, { name: 'profile', type: 'string' },
  { name: 'registry', type: 'address' }, { name: 'registryCodeHash', type: 'bytes32' }, { name: 'hostId', type: 'bytes32' },
  { name: 'hostGeneration', type: 'uint64' }, { name: 'qualificationDigest', type: 'bytes32' }, { name: 'trustAnchorId', type: 'bytes32' },
  { name: 'hardwareId', type: 'bytes32' }, { name: 'resourceDigest', type: 'bytes32' }, { name: 'descriptorDigest', type: 'bytes32' },
  { name: 'owner', type: 'address' }, { name: 'ownerRevision', type: 'uint64' }, { name: 'policyHash', type: 'bytes32' },
  { name: 'reporterPolicyDigest', type: 'bytes32' }, { name: 'reporterRevision', type: 'uint64' }];
export const HOST_AUTHORITY_KEYS = Object.freeze([...HOST_AUTHORITY_TYPE.map(f => f.name), 'digest']);
const U64_KEYS = ['chainId', 'hostGeneration', 'ownerRevision', 'reporterRevision'];
const V1_RECORD_KEYS = ['deployment', 'host', 'generation', 'policyRevision', 'sequence', 'issuedAt', 'validUntil'];
const V2_TYPES = Object.freeze({
  ServingPermit: [
    { name: 'deployment', type: 'bytes32' }, { name: 'host', type: 'bytes32' },
    { name: 'generation', type: 'uint64' }, { name: 'policyRevision', type: 'uint64' },
    { name: 'sequence', type: 'uint64' }, { name: 'issuedAt', type: 'uint64' }, { name: 'validUntil', type: 'uint64' },
    { name: 'hostAuthority', type: 'HostAuthority' }],
  HostAuthority: HOST_AUTHORITY_TYPE });
// identical bounds to deployment-serving-permit.mjs MAX_PERMIT_SEC / CLOCK_SKEW_SEC (not imported: no import cycle)
const MAX_PERMIT_SEC = 20;

export function exactU64(v, what) {
  if (typeof v !== 'string' || !DEC.test(v) || BigInt(v) > UINT64_MAX) throw Error(`${what} must be an exact uint64 decimal string`);
  return BigInt(v);
}
const dec = (v, what) => {
  if (typeof v === 'bigint' && v >= 0n && v <= UINT64_MAX) return v.toString();
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && DEC.test(v) && BigInt(v) <= UINT64_MAX) return v;
  throw Error(`${what} is not an exact uint64 in the supported range`);
};

/** Exact explicit pins selection. Absent -> v1 (false). Anything else that is not exactly v2 for the profile -> refused. */
export function isHostAuthorityPermit(pins) {
  const s = pins?.servingPermit;
  if (s === undefined) return false;
  if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).length !== 2 || s.version !== 2 || s.profile !== HOST_AUTHORITY_PROFILE)
    throw Error('pins.servingPermit must be exactly { version: 2, profile: independent-host-registry-r1 }');
  return true;
}

const contextDomain = chainId => ({ name: 'EnclaveHostAuthority', version: '1', chainId });
function message(c) {
  const m = {};
  for (const f of HOST_AUTHORITY_TYPE) m[f.name] = U64_KEYS.includes(f.name) ? BigInt(c[f.name]) : c[f.name];
  return m;
}
export const hostAuthorityDigest = c => hashTypedData({ domain: contextDomain(Number(c.chainId)), types: { HostAuthority: HOST_AUTHORITY_TYPE },
  primaryType: 'HostAuthority', message: message(c) });

export function reporterPolicyDigest(keys, threshold) {
  if (!Array.isArray(keys) || !Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw Error('reporter policy malformed');
  return keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'uint8' }], [keys.map(k => getAddress(k)), threshold]));
}

/** Exact field/format/digest validation. Unknown or missing fields, wrong formats or a digest mismatch refuse. -> ctx */
export function validateHostAuthorityContext(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw Error('host authority context missing');
  const keys = Object.keys(c);
  if (keys.length !== HOST_AUTHORITY_KEYS.length || HOST_AUTHORITY_KEYS.some(k => !Object.hasOwn(c, k))) throw Error('host authority context has unknown or missing fields');
  if (c.version !== HOST_AUTHORITY_VERSION || c.profile !== HOST_AUTHORITY_PROFILE) throw Error('host authority context version/profile differs');
  for (const k of U64_KEYS) exactU64(c[k], `hostAuthority.${k}`);
  if (c.hostGeneration === '0' || c.ownerRevision === '0') throw Error('host authority generation/revision must be enrolled (non-zero)');
  for (const k of ['registry', 'owner']) if (!A20.test(c[k]) || /^0x0{40}$/.test(c[k])) throw Error(`hostAuthority.${k} must be a lowercase non-zero address`);
  for (const k of ['registryCodeHash', 'hostId', 'qualificationDigest', 'trustAnchorId', 'hardwareId', 'resourceDigest', 'descriptorDigest',
    'policyHash', 'reporterPolicyDigest']) if (!H32.test(c[k])) throw Error(`hostAuthority.${k} must be a lowercase bytes32`);
  if (c.digest !== hostAuthorityDigest(c)) throw Error('host authority digest does not match its fields');
  return c;
}

/** Adapter hostLifecycleState (exact strings) + pinned identity -> frozen exact context. Only an Online host has a servable context. */
export function hostAuthorityContextOf(hr, { chainId, hostId, registryCodeHash }) {
  if (!hr || hr.scope !== 'host' || hr.codeConsistent !== true) throw Error('canonical host lifecycle missing or not code-consistent: unknown');
  const c = { version: HOST_AUTHORITY_VERSION, chainId: dec(chainId, 'chainId'), profile: HOST_AUTHORITY_PROFILE,
    registry: String(hr.registry).toLowerCase(), registryCodeHash: String(registryCodeHash).toLowerCase(), hostId: String(hostId).toLowerCase(),
    hostGeneration: dec(hr.generation, 'host generation'), qualificationDigest: hr.qualificationDigest, trustAnchorId: hr.trustAnchorId,
    hardwareId: hr.hardwareId, resourceDigest: hr.resourceDigest, descriptorDigest: hr.descriptorDigest,
    owner: String(hr.owner).toLowerCase(), ownerRevision: dec(hr.revision, 'owner revision'), policyHash: hr.policyHash,
    reporterPolicyDigest: reporterPolicyDigest(hr.reporters?.keys ?? [], hr.reporters?.threshold ?? 0), reporterRevision: dec(hr.reporters?.revision, 'reporter revision') };
  return Object.freeze(validateHostAuthorityContext({ ...c, digest: hostAuthorityDigest(c) }));
}

/** Same-block evidence emitted by the adapter snapshot: the context, its canonical status and the authenticated block it was read at. */
export function hostAuthorityEvidenceOf(hr, { chainId, hostId, registryCodeHash, blockHash, proofVerified }) {
  if (!H32.test(String(blockHash).toLowerCase())) throw Error('host authority evidence needs the authenticated block hash');
  return Object.freeze({ context: hostAuthorityContextOf(hr, { chainId, hostId, registryCodeHash }), status: hr.status,
    blockHash: String(blockHash).toLowerCase(), proofVerified: proofVerified === true });
}

/** Monotonic host-wide floor: host generation and owner revision are separate non-decreasing axes. -> 'equal' | 'advance' */
export function compareHostAuthority(floor, c) {
  if (!floor) return 'advance';
  const g = BigInt(c.hostGeneration), fg = BigInt(floor.hostGeneration), r = BigInt(c.ownerRevision), fr = BigInt(floor.ownerRevision);
  if (g < fg || r < fr) throw Error(`host authority rollback (generation ${c.hostGeneration}/revision ${c.ownerRevision} below accepted ${floor.hostGeneration}/${floor.ownerRevision})`);
  if (g === fg && r === fr) { if (c.digest !== floor.digest) throw Error('host authority equivocation at the accepted generation and revision'); return 'equal'; }
  return 'advance';
}

/** v2 typed data: the exact v1 field rules PLUS the nested exact host authority, under a separate domain version. */
export function servingPermitTypedDataV2(pins, record) {
  if (!Number.isSafeInteger(pins?.chainId) || pins.chainId < 1) throw Error('invalid chain');
  if (!record || typeof record !== 'object') throw Error('invalid permit record');
  const keys = Object.keys(record);
  if (keys.length !== V1_RECORD_KEYS.length + 1 || ![...V1_RECORD_KEYS, 'hostAuthority'].every(k => Object.hasOwn(record, k)))
    throw Error('v2 permit record has unknown or missing fields (v1 records are refused by this profile)');
  for (const k of ['deployment', 'host']) if (!H32.test(record[k] || '')) throw Error(`invalid ${k}`);
  for (const k of ['generation', 'policyRevision', 'sequence', 'issuedAt', 'validUntil'])
    if (!Number.isSafeInteger(record[k]) || record[k] < 0) throw Error(`invalid ${k}`);
  if (record.generation === 0 || record.policyRevision === 0 || record.sequence === 0 ||
      record.validUntil <= record.issuedAt || record.validUntil - record.issuedAt > MAX_PERMIT_SEC)
    throw Error('invalid permit lifetime or generation');
  const c = validateHostAuthorityContext(record.hostAuthority);
  if (c.hostId !== record.host || c.chainId !== String(pins.chainId)) throw Error('host authority binds another host or chain');
  const { hostAuthority, ...rest } = record;
  return { domain: { ...SERVING_PERMIT_V2, chainId: pins.chainId, verifyingContract: getAddress(pins.lifecycle) }, types: V2_TYPES,
    primaryType: 'ServingPermit', message: { ...rest, hostAuthority: message(hostAuthority) } };
}

/**
 * The verifier's OWN same-block host authority against the signed one. options.hostAuthority is the evidence from the caller's
 * authenticated reader (never from the permit transport); options.hostAdmitted is the current host-local admission (registry
 * Offline/refusal/hold) that an operational certificate must not overwrite; options.hostAuthorityFloor is the durable host-wide floor.
 */
export function checkPermitHostAuthority(record, { hostAuthority: e, hostAdmitted, hostAuthorityFloor = null, assignment, generationAuthority }) {
  const c = record.hostAuthority;
  if (!e || typeof e !== 'object' || e.proofVerified !== true) throw Error('no proof-qualified host authority evidence from the verifier\'s own reader');
  if (e.status !== 'online') throw Error(`canonical host is ${String(e.status)}: no serving permit`);
  const mine = validateHostAuthorityContext(e.context);
  if (HOST_AUTHORITY_KEYS.some(k => mine[k] !== c[k])) throw Error('signed host authority differs from the current canonical host authority');
  const anchor = generationAuthority?.anchor?.hash ?? assignment?.blockHash;
  if (!H32.test(String(anchor ?? '').toLowerCase()) || String(anchor).toLowerCase() !== e.blockHash)
    throw Error('host authority evidence is not from the same authenticated block as the assignment');
  if (hostAdmitted !== true) throw Error('current host admission refused or unknown');
  compareHostAuthority(hostAuthorityFloor, c);
  return mine;
}

/** Adapter snapshot -> the exact servable context (Online, proof-qualified evidence). Used by the runtime permit producer. */
export function permitHostAuthorityOf(snapshot) {
  const e = snapshot?.hostAuthorityEvidence;
  if (!e || e.proofVerified !== true || e.status !== 'online') throw Error('snapshot has no proof-qualified Online host authority: no v2 permit');
  return validateHostAuthorityContext(e.context);
}

/**
 * The REAL snapshot -> gate servingContext conversion (v2 only; v1 returns undefined and the runtime keeps snapshot.servingContext).
 * Operational branch: the runner's { generationAuthority } plus the snapshot's same-block host evidence and the CURRENT host-local
 * admission (the runner already folded dispatch/registry refusals into snapshot.admitted). Non-operational: the authenticated
 * snapshot's own assignment, aged from its block time (never relabelled with the current time).
 */
export function servingContextOf(pins, snapshot) {
  if (!isHostAuthorityPermit(pins)) return undefined;
  const base = { hostAuthority: snapshot?.hostAuthorityEvidence, hostAdmitted: snapshot?.admitted === true };
  if (snapshot?.servingContext?.generationAuthority) return { ...snapshot.servingContext, ...base };
  const a = snapshot?.assignment, blockSec = Math.floor(Number(snapshot?.blockAt) / 1000);
  if (!a || !Number.isSafeInteger(blockSec)) throw Error('snapshot lacks an authenticated assignment for the serving context');
  return { ...base, policy: snapshot.policy, assignment: { deployment: snapshot.id, host: a.host, state: a.state, operator: a.operator,
    generation: a.generation, policyRevision: a.revision, admitted: snapshot.admitted === true, funded: snapshot.funded === true,
    authorityTier: snapshot.authorityTier, proofVerified: snapshot.proofVerified === true, observedAt: blockSec, blockTimestamp: blockSec,
    blockHash: String(snapshot.blockHash || '').toLowerCase() } };
}
