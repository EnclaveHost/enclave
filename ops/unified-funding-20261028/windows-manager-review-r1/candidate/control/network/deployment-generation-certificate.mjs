// Fast operational authority is a chained >2/3 witness certificate rooted in
// authenticated owner policy. It is distinct from transaction finality. It
// cannot mint budget, prolong paid runtime, change policy, clear a ban, or
// authorize an unfenced successor. The chain adapter separately records each
// exact transition digest on chain and reconciles its receipt.
import { getAddress, hashTypedData, keccak256, recoverTypedDataAddress, toBytes } from 'viem';
import { validateLifecycleAuthorityWindow } from './deployment-authority-window.mjs';
const HASH = /^0x[0-9a-f]{64}$/;
const ZERO = `0x${'0'.repeat(64)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const TYPES = { Generation: [
  { name: 'deployment', type: 'bytes32' }, { name: 'anchorHash', type: 'bytes32' },
  { name: 'anchorNumber', type: 'uint64' }, { name: 'policyRevision', type: 'uint64' },
  { name: 'witnessesHash', type: 'bytes32' }, { name: 'previous', type: 'bytes32' },
  { name: 'generation', type: 'uint64' }, { name: 'host', type: 'bytes32' },
  { name: 'operator', type: 'address' }, { name: 'action', type: 'uint8' },
  { name: 'issuedAt', type: 'uint64' }, { name: 'validUntil', type: 'uint64' },
  { name: 'fundedUntil', type: 'uint64' }, { name: 'remainingWei', type: 'uint256' },
  { name: 'transitionIntent', type: 'bytes32' },
] };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const amount = n => {
  if (typeof n !== 'bigint' && !(typeof n === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(n))) throw Error('invalid certificate amount');
  const v = BigInt(n); if (v < 0n || v >= 2n ** 256n) throw Error('invalid certificate amount'); return v;
};
export function certificateWitnessesHash(policy) {
  if (!policy || !Array.isArray(policy.witnesses) || policy.witnesses.length < 3 || policy.witnesses.length > 16 ||
      !Number.isInteger(policy.threshold) || policy.threshold * 3 <= policy.witnesses.length * 2 || policy.threshold > policy.witnesses.length)
    throw Error('invalid certificate witness policy');
  const witnesses = policy.witnesses.map(a => getAddress(a).toLowerCase());
  if (new Set(witnesses).size !== witnesses.length) throw Error('duplicate certificate witness');
  return keccak256(toBytes(JSON.stringify([policy.revision, policy.threshold, witnesses, policy.maxAnchorAgeSec,
    String(amount(policy.maxTransitionWei)), String(amount(policy.stopReserveWei))])));
}
export function generationTypedData(pins, record) {
  if (!Number.isSafeInteger(pins.chainId) || pins.chainId <= 0) throw Error('invalid certificate chain');
  for (const name of ['deployment', 'anchorHash', 'witnessesHash', 'previous', 'host', 'transitionIntent'])
    if (!HASH.test(record?.[name] || '')) throw Error(`invalid certificate ${name}`);
  for (const name of ['anchorNumber', 'policyRevision', 'generation', 'issuedAt', 'validUntil', 'fundedUntil', 'action'])
    if (!integer(record[name])) throw Error(`invalid certificate ${name}`);
  if (![1, 2, 3].includes(record.action) || record.validUntil <= record.issuedAt || record.policyRevision === 0 || record.generation === 0 ||
      record.transitionIntent === ZERO) throw Error('invalid certificate bounds');
  return { domain: { name: 'EnclaveLifecycleGeneration', version: '1', chainId: pins.chainId,
    verifyingContract: getAddress(pins.lifecycle) }, types: TYPES, primaryType: 'Generation',
    message: { ...record, operator: getAddress(record.operator), remainingWei: amount(record.remainingWei) } };
}
export function generationAnchorDigest(pins, anchor, policy) {
  const state = anchor.assignment;
  return keccak256(toBytes(JSON.stringify([pins.chainId, getAddress(pins.lifecycle), anchor.hash, anchor.number,
    state.deployment, state.generation, state.state, state.host, state.operator, state.changedAt, state.startAfter,
    state.failures, state.crashHeld, policy.revision, certificateWitnessesHash(policy),
    String(amount(anchor.balanceWei)), anchor.fundedUntil, String(amount(policy.maxTransitionWei)), String(amount(policy.stopReserveWei))])));
}
async function processGenerationChain(envelopes, { pins, anchor, head, policy, nowSec, denyFloor = null }, unsignedLast = false) {
  const window = validateLifecycleAuthorityWindow({ anchor, head, policy, nowSec, denyFloor });
  if (!Array.isArray(envelopes) || envelopes.length > 128) throw Error('generation chain too long');
  const witnessesHash = certificateWitnessesHash(policy);
  if (anchor.policyHash !== witnessesHash) throw Error('certificate policy differs from authenticated anchor');
  const allowed = new Set(policy.witnesses.map(a => getAddress(a).toLowerCase()));
  const states = { queued: 1, running: 2, stopped: 3 };
  let previous = generationAnchorDigest(pins, anchor, policy), current = { ...anchor.assignment,
    remainingWei: amount(anchor.balanceWei), fundedUntil: anchor.fundedUntil, digest: previous };
  if (!HASH.test(current.deployment || '') || !integer(current.generation) || !states[current.state] ||
      !integer(current.changedAt) || !integer(current.startAfter) || !integer(current.failures) || typeof current.crashHeld !== 'boolean')
    throw Error('invalid generation anchor assignment');
  for (const [index, envelope] of envelopes.entries()) {
    const r = envelope.record, data = generationTypedData(pins, r);
    if (r.deployment !== current.deployment || r.anchorHash !== anchor.hash || r.anchorNumber !== anchor.number ||
        r.policyRevision !== policy.revision || r.witnessesHash !== witnessesHash || r.previous !== previous ||
        r.generation !== current.generation + 1) throw Error('certificate does not extend the anchored generation');
    if (r.issuedAt < current.changedAt || r.issuedAt > nowSec + 2 || r.validUntil <= nowSec ||
        r.validUntil > anchor.timestamp + policy.maxAnchorAgeSec || r.fundedUntil > current.fundedUntil || r.fundedUntil < r.validUntil)
      throw Error('certificate exceeds authority lifetime');
    const remainingWei = amount(r.remainingWei), cost = amount(policy.maxTransitionWei);
    if (cost <= 0n || current.remainingWei < cost || remainingWei > current.remainingWei - cost ||
        (r.action !== 3 && remainingWei <= amount(policy.stopReserveWei))) throw Error('certificate exceeds funded authority');
    if (r.action === states[current.state] || current.state === 'stopped') throw Error('invalid certificate state transition');
    let failures = current.failures, crashHeld = current.crashHeld, startAfter = current.startAfter;
    if (r.action === 2) {
      if (current.state !== 'queued' || crashHeld || r.issuedAt < startAfter || r.host === ZERO || getAddress(r.operator) === ZERO_ADDRESS)
        throw Error('certificate successor is not startable');
    } else {
      if (r.host !== ZERO || getAddress(r.operator) !== ZERO_ADDRESS) throw Error('idle certificate has a host');
      if (current.state === 'running') {
        startAfter = r.issuedAt + 22;
        if (r.action === 1) {
          failures++; crashHeld = failures >= 5;
          startAfter = Math.max(startAfter, r.issuedAt + Math.min(300, 5 * 2 ** Math.min(failures - 1, 6)));
        }
      }
    }
    const proposal = unsignedLast && index === envelopes.length - 1;
    if (!proposal && (!Array.isArray(envelope.signatures) || envelope.signatures.length < policy.threshold || envelope.signatures.length > allowed.size))
      throw Error('certificate quorum missing');
    const signers = new Set();
    for (const signature of proposal ? [] : envelope.signatures) {
      const signer = (await recoverTypedDataAddress({ ...data, signature })).toLowerCase();
      if (!allowed.has(signer) || signers.has(signer)) throw Error('invalid certificate quorum');
      signers.add(signer);
    }
    previous = hashTypedData(data);
    current = { deployment: r.deployment, generation: r.generation, policyRevision: policy.revision,
      state: ['unknown', 'queued', 'running', 'stopped'][r.action], host: r.host, operator: r.operator,
      changedAt: r.issuedAt, startAfter, failures, crashHeld, remainingWei, fundedUntil: r.fundedUntil, digest: previous };
  }
  return { assignment: current, authority: window };
}

export const verifyGenerationChain = (envelopes, context) => processGenerationChain(envelopes, context);
// For the signing boundary only. This return value is NOT serving authority:
// the proposed successor has not acquired a quorum yet.
export async function prepareGenerationProposal(record, predecessors, context) {
  const result = await processGenerationChain([...predecessors, { record, signatures: [] }], context, true);
  return { proposal: result.assignment, typedData: generationTypedData(context.pins, record) };
}
