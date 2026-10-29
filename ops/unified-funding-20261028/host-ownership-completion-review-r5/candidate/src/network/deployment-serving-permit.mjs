// Off-chain liveness/fencing for the event-driven lifecycle. A host heartbeat
// alone is not a serving permit: an owner-selected witness quorum must sign the
// exact generation. Witnesses durably stop granting the old generation before
// certifying failure. A takeover waits out MAX_PERMIT_SEC + CLOCK_SKEW_SEC.
// No function in this module sends a blockchain transaction.
import { recoverTypedDataAddress, hashTypedData, getAddress, keccak256, toBytes } from 'viem';
import { verifyGenerationChain } from './deployment-generation-certificate.mjs';
import { canRestoreLifecycleDenial, lifecycleHostAdmitted } from './deployment-authority-window.mjs';
const OPERATIONAL = Symbol('verified generation authority');

export const MAX_PERMIT_SEC = 20;
export const CLOCK_SKEW_SEC = 2;
export const MAX_AUTHORITY_AGE_SEC = 20;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const TYPES = { ServingPermit: [
  { name: 'deployment', type: 'bytes32' }, { name: 'host', type: 'bytes32' },
  { name: 'generation', type: 'uint64' }, { name: 'policyRevision', type: 'uint64' },
  { name: 'sequence', type: 'uint64' }, { name: 'issuedAt', type: 'uint64' }, { name: 'validUntil', type: 'uint64' },
] };

export function servingPermitTypedData(pins, record) {
  if (!Number.isSafeInteger(pins.chainId) || pins.chainId < 1) throw new Error('invalid chain');
  for (const k of ['deployment', 'host']) if (!HASH.test(record[k] || '')) throw new Error(`invalid ${k}`);
  for (const k of ['generation', 'policyRevision', 'sequence', 'issuedAt', 'validUntil'])
    if (!Number.isSafeInteger(record[k]) || record[k] < 0) throw new Error(`invalid ${k}`);
  if (record.generation === 0 || record.policyRevision === 0 || record.sequence === 0 ||
      record.validUntil <= record.issuedAt || record.validUntil - record.issuedAt > MAX_PERMIT_SEC)
    throw new Error('invalid permit lifetime or generation');
  return { domain: { name: 'EnclaveServingPermit', version: '1', chainId: pins.chainId,
    verifyingContract: getAddress(pins.lifecycle) }, types: TYPES, primaryType: 'ServingPermit', message: record };
}

export async function signServingPermit(account, pins, record) {
  return account.signTypedData(servingPermitTypedData(pins, record));
}

// Same generation/revision cannot acquire another host or witness set even if
// a later RPC response calls the conflicting snapshot verified.
export function servingAssignmentBinding(pins, assignment, policy) {
  return keccak256(toBytes(JSON.stringify([pins.chainId, getAddress(pins.lifecycle),
    assignment.deployment.toLowerCase(), assignment.host.toLowerCase(), getAddress(assignment.operator),
    assignment.generation, assignment.policyRevision, policy.threshold, policy.witnesses.map(a => getAddress(a))])));
}

export async function resolveServingContext(options) {
  if (!options.generationAuthority) {
    if (options.denyFloor) throw Error('deployment denied; authenticated restoration required');
    return options;
  }
  const g = options.generationAuthority;
  const result = await verifyGenerationChain(g.certificates, { ...g, denyFloor: null, pins: options.pins, nowSec: options.nowSec });
  const denial = options.denyFloor ?? g.denyFloor;
  if (denial && !canRestoreLifecycleDenial(denial, g.anchor, options.nowSec)) throw Error('deployment denied; authenticated restoration required');
  const a = result.assignment;
  if (!lifecycleHostAdmitted(g.anchor, a.host)) throw Error('assigned host is not admitted');
  return { ...options, restoredAt: denial ? g.anchor.number : null, policy: g.policy, assignment: { ...a, policyRevision: g.policy.revision,
    proofVerified: true, authorityTier: g.anchor.tier, admitted: g.anchor.admitted,
    funded: a.remainingWei > BigInt(g.policy.stopReserveWei) && a.fundedUntil > options.nowSec,
    [OPERATIONAL]: result.authority.validUntil } };
}

export function validateServingPermitContext(record, { pins, assignment, policy, nowSec, floor = null }) {
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) throw new Error('invalid clock');
  const data = servingPermitTypedData(pins, record || {}), r = record;
  // assignment/policy are read by the caller's existing authenticated chain
  // reader, NEVER taken from the heartbeat transport. The bounded snapshot
  // prevents an isolated old host from serving indefinitely on a cached head.
  if (!assignment || assignment.state !== 'running' || assignment.host?.toLowerCase() !== r.host.toLowerCase() ||
      assignment.deployment?.toLowerCase() !== r.deployment.toLowerCase() || assignment.generation !== r.generation ||
      assignment.policyRevision !== r.policyRevision) throw new Error('permit is not for the current running assignment');
  if (assignment.admitted !== true || assignment.funded !== true) throw new Error('deployment is disabled, banned or unfunded');
  if (!['safe', 'finalized', 'l1-finalized-derived'].includes(assignment.authorityTier) || assignment.proofVerified !== true)
    throw new Error('unqualified assignment authority');
  const operationalUntil = assignment[OPERATIONAL];
  if (operationalUntil !== undefined ? operationalUntil <= nowSec :
      (!Number.isSafeInteger(assignment.observedAt) || assignment.observedAt > nowSec + CLOCK_SKEW_SEC ||
      nowSec - assignment.observedAt > MAX_AUTHORITY_AGE_SEC || !Number.isSafeInteger(assignment.blockTimestamp) ||
      assignment.blockTimestamp > nowSec + CLOCK_SKEW_SEC || nowSec - assignment.blockTimestamp > MAX_AUTHORITY_AGE_SEC))
    throw new Error('stale assignment authority');
  if (r.issuedAt > nowSec + CLOCK_SKEW_SEC || r.validUntil <= nowSec + CLOCK_SKEW_SEC)
    throw new Error('permit expired or from the future');
  if (!policy || policy.revision !== r.policyRevision || !Array.isArray(policy.witnesses) ||
      policy.witnesses.length < 3 || policy.witnesses.length > 16 || !Number.isInteger(policy.threshold) ||
      policy.threshold <= policy.witnesses.length * 2 / 3 || policy.threshold > policy.witnesses.length)
    throw new Error('invalid witness policy');
  const allowed = new Set(policy.witnesses.map(a => getAddress(a).toLowerCase()));
  if (allowed.size !== policy.witnesses.length) throw new Error('duplicate configured witness');
  const digest = hashTypedData(data);
  if (floor && (floor.generation > r.generation || floor.generation === r.generation &&
      (floor.sequence > r.sequence || floor.sequence === r.sequence && floor.digest !== digest)))
    throw new Error('permit replay or equivocation');
  return { data, record: r, digest, allowed,
    serveUntil: Math.min(r.validUntil - CLOCK_SKEW_SEC, operationalUntil ?? assignment.blockTimestamp + MAX_AUTHORITY_AGE_SEC) };
}

export async function verifyServingPermit(envelope, options) {
  options = await resolveServingContext(options);
  const { policy } = options;
  const { data, record: r, digest, allowed, serveUntil } = validateServingPermitContext(envelope?.record, options);
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length < policy.threshold ||
      envelope.signatures.length > policy.witnesses.length) throw new Error('missing witness quorum');
  const signers = new Set();
  for (const signature of envelope.signatures) {
    const signer = (await recoverTypedDataAddress({ ...data, signature })).toLowerCase();
    if (!allowed.has(signer) || signers.has(signer)) throw new Error('unauthorized or duplicate witness');
    signers.add(signer);
  }
  return { record: r, assignment: options.assignment, policy, restoredAt: options.restoredAt,
    signers: [...signers], floor: { generation: r.generation, sequence: r.sequence, digest },
    // Consumers must drop existing streams/writes as well as refuse new ones.
    serveUntil };
}
