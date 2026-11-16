// Proof of capacity on the Windows node (docs/design/proof-of-capacity.md): OFF unless PROOF_OF_CAPACITY=1, and then
// only on a ledger whose prover is an EnclaveProofOfCapacity (its proofSchema reads 3). The contract is the address the
// proof of time already uses (the address book's proofOfTime: the ledger's prover).
//
// On this platform the proof key is a file of the node process, on the host: an answer to a capacity check and this
// box's own proof are the HOST's CPU and memory work, signed by the host. They say nothing about a Shield partition.
import {recoverTypedDataAddress, recoverMessageAddress} from 'viem';
import {capacityReader, createCapacityResponder, createCapacityChecker, createCapacityAgent, selfCapacityRecord, createClaimReader,
  POC_ABI} from '../../network/proof-of-capacity-host.mjs';

export const PROOF_OF_CAPACITY = process.env.PROOF_OF_CAPACITY === '1';
export const PROOF_OF_CAPACITY_MS = Math.max(60, parseInt(process.env.PROOF_OF_CAPACITY_SEC || '300', 10) || 300) * 1000;

/**
 * chain: {addresses, publicClient(), readEnclave(id), sendOperatorTx(address, abi, fn, args), proofSign(typedData),
 *         proofAddress(), blockNumber(), chainId}
 * hostId() -> this box's enclave id (null until registered); wantsCredit() -> a paid lease is being served now
 * -> get(): the responder and the agent, or null while off / not ready / the prover is not one (said once per reason)
 */
export function createNodeProofOfCapacity({chain, hostId, wantsCredit, log = () => {}, enabled = PROOF_OF_CAPACITY}) {
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
      answer: createCapacityResponder({hostId: host, domain, reader, proofKeyOf, sign, recover}),
      agent: createCapacityAgent({host, domain, reader, sign, wantsCredit, log: m => log(m),
        send: (functionName, args) => chain.sendOperatorTx(address, POC_ABI, functionName, args),
        check: createCapacityChecker({host, domain, sign, recover, targetOf,
          // how much is asked of a host: what its own signed capacity record says it has free (lanes = free vCPUs)
          claimOf: createClaimReader({chainId: chain.chainId, registry: chain.addresses.registry,
            recoverMessage: (message, signature) => recoverMessageAddress({message, signature})}),
          reachable: () => chain.blockNumber().then(() => true, () => false)}),
        selfCheck: selfCapacityRecord(host)})};
    log(`proof of capacity on: ${address}, host ${host.slice(0, 10)}, every ${PROOF_OF_CAPACITY_MS / 1000}s`);
    return current;
  };
}
