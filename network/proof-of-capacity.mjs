// The hosts' side of EnclaveProofOfCapacity (contracts/EnclaveProofOfCapacity.sol): the three messages a host's
// in-enclave proof key signs, and one epoch's round of duty. A host is credited for proven time only while it is in
// standing: checked by the hosts assigned to it and having checked the hosts it was assigned; alone, by its own proof.
//
// Nothing here decides who checks whom or what standing is: the contract does, and this code asks it
// (`targetsOf`, `standing`, `seedOf`). What a check IS (the workload a checker runs against its target and how the
// result is judged) is the caller's `check` function; its digest goes on chain as the report's `evidence`.
import {hashTypedData, keccak256, toBytes} from 'viem';

export const VERDICT = Object.freeze({pass: 1, fail: 2, unreachable: 3});
const HEX32 = /^0x[0-9a-f]{64}$/, ADDR = /^0x[0-9a-fA-F]{40}$/;
const need = (ok, what) => { if (!ok) throw new Error(what); };

export const capacityDomain = ({chainId, contract}) => {
  need(Number.isSafeInteger(chainId) && chainId > 0 && ADDR.test(String(contract || '')), 'chain id and contract address required');
  return {name: 'EnclaveProofOfCapacity', version: '1', chainId, verifyingContract: String(contract).toLowerCase()};
};
const TYPES = {
  CapacityReport: [{name: 'epoch', type: 'uint64'}, {name: 'checker', type: 'bytes32'}, {name: 'target', type: 'bytes32'},
    {name: 'verdict', type: 'uint8'}, {name: 'seed', type: 'bytes32'}, {name: 'evidence', type: 'bytes32'}],
  CapacitySelf: [{name: 'epoch', type: 'uint64'}, {name: 'host', type: 'bytes32'}, {name: 'seed', type: 'bytes32'}, {name: 'evidence', type: 'bytes32'}],
  ProofOfTime: [{name: 'id', type: 'bytes32'}, {name: 'enclaveId', type: 'bytes32'}, {name: 'operator', type: 'address'},
    {name: 'upto', type: 'uint64'}, {name: 'anchorBlock', type: 'uint64'}, {name: 'anchorHash', type: 'bytes32'}],
};
const typed = (domain, primaryType, message) => ({domain: capacityDomain(domain), types: {[primaryType]: TYPES[primaryType]}, primaryType, message});

export function reportMessage(domain, {epoch, checker, target, verdict, seed, evidence}) {
  need(Number.isSafeInteger(epoch) && epoch >= 0, 'epoch');
  need(HEX32.test(checker) && HEX32.test(target) && checker !== target, 'checker and target: two host ids');
  need(Object.values(VERDICT).includes(verdict), 'verdict: pass, fail or unreachable');
  need(HEX32.test(seed) && !/^0x0+$/.test(seed), 'seed: the epoch\'s, from the contract');
  need(HEX32.test(evidence), 'evidence: a 32-byte digest');
  return typed(domain, 'CapacityReport', {epoch: BigInt(epoch), checker, target, verdict, seed, evidence});
}
export function selfMessage(domain, {epoch, host, seed, evidence}) {
  need(Number.isSafeInteger(epoch) && epoch >= 0 && HEX32.test(host), 'epoch and host id');
  need(HEX32.test(seed) && !/^0x0+$/.test(seed) && HEX32.test(evidence), 'seed and evidence');
  return typed(domain, 'CapacitySelf', {epoch: BigInt(epoch), host, seed, evidence});
}
export function proofMessage(domain, {id, enclaveId, operator, upto, anchorBlock, anchorHash}) {
  need(HEX32.test(id) && HEX32.test(enclaveId) && ADDR.test(String(operator || '')) && HEX32.test(anchorHash), 'deployment, host, operator and anchor');
  return typed(domain, 'ProofOfTime', {id, enclaveId, operator: String(operator).toLowerCase(), upto: BigInt(upto), anchorBlock: BigInt(anchorBlock), anchorHash});
}
export const digestOf = message => hashTypedData(message);
// the digest of an off-chain record (canonical JSON text), as a report's or a self-proof's `evidence`
export const evidenceDigest = text => { need(typeof text === 'string' && text.length > 0, 'evidence text'); return keccak256(toBytes(text)); };

/**
 * One round of duty for `host` in the contract's current epoch.
 *   reader: {epochNow(), seedOf(epoch), targetsOf(epoch, host), verdictOf(epoch, checker, target)} - the contract's views
 *   sign(message) -> 65-byte signature by the host's in-enclave proof key (EIP-712 typed data)
 *   check(target, {epoch, seed}) -> {verdict: 'pass'|'fail'|'unreachable', evidence: <text of the record>}
 * -> {epoch, seed, reports: [{epoch, checker, target, verdict, evidence, signature}], skipped: [{target, why}]}
 * A target already reported on is left alone (a report lands once). A check that throws is NOT a verdict: the target is
 * skipped and tried again on the next round, since a fail must be something the checker saw, not something it could
 * not do. An epoch with no seed yet (no transaction in it) has nothing to sign over: {seed: null, reports: []}.
 */
export async function dutyRound({domain, host, reader, sign, check}) {
  need(HEX32.test(host), 'host id');
  const epoch = Number(await reader.epochNow()), seed = await reader.seedOf(epoch);
  if (!HEX32.test(String(seed)) || /^0x0+$/.test(seed)) return {epoch, seed: null, reports: [], skipped: []};
  const reports = [], skipped = [];
  for (const target of await reader.targetsOf(epoch, host)) {
    if (Number(await reader.verdictOf(epoch, host, target)) !== 0) continue;
    let r;
    try { r = await check(target, {epoch, seed}); } catch (e) { skipped.push({target, why: String(e?.message || e).slice(0, 200)}); continue; }
    const verdict = VERDICT[r?.verdict];
    if (!verdict) { skipped.push({target, why: 'the check gave no verdict'}); continue; }
    const evidence = evidenceDigest(r.evidence);
    const signature = await sign(reportMessage(domain, {epoch, checker: host, target, verdict, seed, evidence}));
    reports.push({epoch, checker: host, target, verdict, evidence, signature});
  }
  return {epoch, seed, reports, skipped};
}

/**
 * What `host` still needs to be credited in the current epoch, from the contract's own `standing`.
 *   reader: {epochNow(), seedOf(epoch), standing(host, epoch) -> [ok, why]}
 *   selfCheck({epoch, seed}) -> text of the host's own capacity record (only called when its own proof is what is missing)
 * -> {epoch, ok: true} | {epoch, ok: false, why} | {epoch, ok: false, why, self: {epoch, host, evidence, signature}}
 * A missing duty or failed checks cannot be signed away: those return `why` and nothing to submit.
 */
export async function standingRound({domain, host, reader, sign, selfCheck}) {
  need(HEX32.test(host), 'host id');
  const epoch = Number(await reader.epochNow());
  const [ok, why] = await reader.standing(host, epoch);
  if (ok) return {epoch, ok: true};
  if (why !== 'needs its own proof of capacity') return {epoch, ok: false, why};
  const seed = await reader.seedOf(epoch);
  if (!HEX32.test(String(seed)) || /^0x0+$/.test(seed)) return {epoch, ok: false, why: 'the epoch has no seed yet (touch the contract first)'};
  const evidence = evidenceDigest(await selfCheck({epoch, seed}));
  return {epoch, ok: false, why, self: {epoch, host, evidence, signature: await sign(selfMessage(domain, {epoch, host, seed, evidence}))}};
}
