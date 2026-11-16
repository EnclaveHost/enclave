// Proof of capacity on the Windows node (docs/design/proof-of-capacity.md): OFF unless PROOF_OF_CAPACITY=1, and then
// only on a ledger whose prover is an EnclaveProofOfCapacity (its proofSchema reads 3). The contract is the address the
// proof of time already uses (the address book's proofOfTime: the ledger's prover).
//
// WHERE THE PROOF KEY IS. With a capacity partition (shield-capacity.mjs; `partitionKey`) the key is made in that
// partition's memory: an answer to a capacity check is the partition's work, signed there, and chain.proofSign sends
// every other message there to be signed. Without one the proof key is a file of the node process, on the host: an
// answer is then the HOST's CPU and memory work, signed by the host, and says nothing about a Shield partition.
import {recoverTypedDataAddress, recoverMessageAddress} from 'viem';
import fs from 'node:fs';
import {createAppCheck} from '../../network/proof-of-capacity-app.mjs';
import {createProofKeyCheck} from '../../network/proof-of-capacity-partition.mjs';
import {createCardCheck} from '../../network/proof-of-capacity-card.mjs';
import {capacityReader, createCapacityResponder, createCapacityChecker, createCapacityAgent, selfCapacityRecord, createClaimReader,
  capacityAnswerHere, furtherMode, POC_ABI} from '../../network/proof-of-capacity-host.mjs';

export const PROOF_OF_CAPACITY = process.env.PROOF_OF_CAPACITY === '1';
// a setting that is none of the three stops the node at start: a check that silently does not run is worse than no host
if (PROOF_OF_CAPACITY) for (const k of ['PROOF_OF_CAPACITY_APP', 'PROOF_OF_CAPACITY_CARD', 'PROOF_OF_CAPACITY_KEY']) furtherMode(process.env[k], k);
// the independent verifier as shipped (one file, no packages): what a customer's page runs, run here against a peer
const verifier = () => import('../../verifier/web/dist/enclave-verifier-web.js');

/**
 * The further checks this box runs on a host that passed the work (createCapacityChecker's `also`), from its settings:
 *   - the app the host serves (PROOF_OF_CAPACITY_APP), verified as a customer's page verifies it;
 *   - where an Enclave Shield host's proof key lives (PROOF_OF_CAPACITY_KEY), against the capacity app THIS box's own
 *     Shield policy pins (policyFile; none pinned = not judged).
 *   - a card the host sells by masked offload (PROOF_OF_CAPACITY_CARD): this box sells none and answers no such
 *     check, but it checks one like any other checker (the check needs no card on the checker's side).
 * The first two need the relay (it carries a Shield host's TPM session and lists a box's apps); with no relay base
 * neither runs.
 */
export function nodeFurtherChecks({chain, host, relayBase, domain, sign, recover, policyFile = process.env.SHIELD_APP_POLICY_FILE || process.env.ENCLAVE_NETWORK_SHIELD_POLICY || '',
  env = process.env, log = () => {}}) {
  const out = [], mode = k => furtherMode(env[k], k), app = mode('PROOF_OF_CAPACITY_APP'), key = mode('PROOF_OF_CAPACITY_KEY'), card = mode('PROOF_OF_CAPACITY_CARD');
  if (card !== 'off') out.push(createCardCheck({host, domain, sign, recover, enforce: card === 'enforce'}));
  if (!/^https:\/\//.test(String(relayBase || ''))) { log('proof of capacity: no relay base, so no app and no proof-key check of other hosts'); return out; }
  // (the key before the app: both ask an Enclave Shield box for a TPM session and the relay allows one per box per 20 s.
  // A verified key is remembered for a day, so the app gets the session on every round after the first.)
  if (key !== 'off') out.push(createProofKeyCheck({host, apiBase: relayBase, verifier, enforce: key === 'enforce',
    policy: () => { if (!policyFile) throw new Error('no Shield policy file on this box'); return JSON.parse(fs.readFileSync(policyFile, 'utf8')); }}));
  if (app !== 'off') out.push(createAppCheck({host, apiBase: relayBase, verifier, enforce: app === 'enforce',
    leaseOf: async id => { const d = await chain.readDeployment(id); return d ? {runner: d.runner, leaseUntil: Number(d.leaseUntil), active: d.active === true, isPublic: d.isPublic === true} : null; }}));
  return out;
}
export const PROOF_OF_CAPACITY_MS = Math.max(60, parseInt(process.env.PROOF_OF_CAPACITY_SEC || '300', 10) || 300) * 1000;

/**
 * chain: {addresses, publicClient(), readEnclave(id), sendOperatorTx(address, abi, fn, args), proofSign(typedData),
 *         proofAddress(), blockNumber(), chainId}
 * hostId() -> this box's enclave id (null until registered); wantsCredit() -> a paid lease is being served now
 * -> get(): the responder and the agent, or null while off / not ready / the prover is not one (said once per reason)
 */
export function createNodeProofOfCapacity({chain, hostId, wantsCredit, log = () => {}, enabled = PROOF_OF_CAPACITY, partitionKey = () => null, further = () => []}) {
  let current = null, refused = '';
  return async function get() {
    const address = chain.addresses.proofOfTime, host = hostId();
    if (!enabled || !address || !host || !chain.proofAddress()) return null;
    if (current?.address === address && current.host === host) return current;
    const reader = capacityReader(chain.publicClient(), address);
    let schema = null; try { schema = Number(await reader.proofSchema()); } catch {}
    if (schema !== 3) {
      const why = `the ledger's prover ${address} is not an EnclaveProofOfCapacity (proofSchema ${schema ?? 'unread'})`;
      if (why !== refused) log(`proof of capacity off: ${why}`);
      refused = why; return null;
    }
    const domain = {chainId: chain.chainId, contract: address}, sign = m => chain.proofSign(m);
    const recover = (typedData, signature) => recoverTypedDataAddress({...typedData, signature});
    const row = id => chain.readEnclave(id).catch(() => null);
    const targetOf = async id => { const e = await row(id); return e && e.active ? {endpoint: e.endpoint, proofKey: e.proofKey, operator: e.operator} : null; };
    const proofKeyOf = async id => { const e = await row(id); return e && !/^0x0+$/.test(String(e.proofKey)) ? e.proofKey : null; };
    current = {address, host,
      answer: createCapacityResponder({hostId: host, domain, reader, proofKeyOf, sign, recover,
        answerOf: (c, d) => { const k = partitionKey(); return k ? k.answerOf(c, d) : capacityAnswerHere(c, d, sign); }}),
      agent: createCapacityAgent({host, domain, reader, sign, wantsCredit, log: m => log(m),
        send: (functionName, args) => chain.sendOperatorTx(address, POC_ABI, functionName, args),
        check: createCapacityChecker({host, domain, sign, recover, targetOf,
          // how much is asked of a host: what its own signed capacity record says it has free (lanes = free vCPUs)
          claimOf: createClaimReader({chainId: chain.chainId, registry: chain.addresses.registry,
            recoverMessage: (message, signature) => recoverMessageAddress({message, signature})}),
          reachable: () => chain.blockNumber().then(() => true, () => false), also: further({host, domain, sign, recover})}),
        selfCheck: selfCapacityRecord(host)})};
    log(`proof of capacity on: ${address}, host ${host.slice(0, 10)}, every ${PROOF_OF_CAPACITY_MS / 1000}s`);
    return current;
  };
}
