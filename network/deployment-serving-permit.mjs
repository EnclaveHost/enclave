// Off-chain liveness/fencing for the event-driven lifecycle. A host heartbeat
// alone is not a serving permit: an owner-selected witness quorum must sign the
// exact generation. Witnesses durably stop granting the old generation before
// certifying failure. A takeover waits out MAX_PERMIT_SEC + CLOCK_SKEW_SEC.
// No function in this module sends a blockchain transaction.
import { recoverTypedDataAddress, hashTypedData, getAddress } from 'viem';

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

export async function verifyServingPermit(envelope, { pins, assignment, policy, nowSec, floor = null }) {
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) throw new Error('invalid clock');
  const data = servingPermitTypedData(pins, envelope?.record || {}), r = envelope.record;
  // assignment/policy are read by the caller's existing authenticated chain
  // reader, NEVER taken from the heartbeat transport. The bounded snapshot
  // prevents an isolated old host from serving indefinitely on a cached head.
  if (!assignment || assignment.state !== 'running' || assignment.host?.toLowerCase() !== r.host.toLowerCase() ||
      assignment.deployment?.toLowerCase() !== r.deployment.toLowerCase() || assignment.generation !== r.generation ||
      assignment.policyRevision !== r.policyRevision) throw new Error('permit is not for the current running assignment');
  if (assignment.admitted !== true || assignment.funded !== true) throw new Error('deployment is disabled, banned or unfunded');
  if (!['safe', 'finalized'].includes(assignment.authorityTier) || assignment.proofVerified !== true)
    throw new Error('unqualified assignment authority');
  if (!Number.isSafeInteger(assignment.observedAt) || assignment.observedAt > nowSec + CLOCK_SKEW_SEC ||
      nowSec - assignment.observedAt > MAX_AUTHORITY_AGE_SEC || !Number.isSafeInteger(assignment.blockTimestamp) ||
      assignment.blockTimestamp > nowSec + CLOCK_SKEW_SEC || nowSec - assignment.blockTimestamp > MAX_AUTHORITY_AGE_SEC)
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
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length < policy.threshold ||
      envelope.signatures.length > policy.witnesses.length) throw new Error('missing witness quorum');
  const signers = new Set();
  for (const signature of envelope.signatures) {
    const signer = (await recoverTypedDataAddress({ ...data, signature })).toLowerCase();
    if (!allowed.has(signer) || signers.has(signer)) throw new Error('unauthorized or duplicate witness');
    signers.add(signer);
  }
  return { record: r, signers: [...signers], floor: { generation: r.generation, sequence: r.sequence, digest },
    // Consumers must drop existing streams/writes as well as refuse new ones.
    serveUntil: Math.min(r.validUntil - CLOCK_SKEW_SEC, assignment.blockTimestamp + MAX_AUTHORITY_AGE_SEC) };
}
