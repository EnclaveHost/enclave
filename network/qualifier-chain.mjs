// The qualification checker's (scripts/network/wg-qualify.mjs) chain authority, as ONE explicit choice.
// The checker reads: a community host's registry operator (address book `addr('registry')`, then `registry.get`), the
// connectivity contract address, and the on-chain qualification digest that its key SIGNS (network/onchain-qualification.mjs).
//   * no --chain-authority (or "quorum"): returns null, and the script keeps its own reads exactly as before (one --rpc
//     provider client, or the --independent agreed RPC quorum);
//   * --chain-authority verifier --chain-verifier http://127.0.0.1:<port>/: EVERY read is an eth_call through the reviewed
//     local-verifier client (network/chain-authority.mjs createChainAuthority: executed over state proven against the
//     block state root of the verifier's sequencer-signed head chain; loopback only). This is the HOST-LOCAL verifier
//     (unsafe tier, no L1 finality); it is NOT an SNP-attested verifier and is never labelled as one. Before every read
//     the verifier's head must be fresh (actionGate) and its chain id the expected one. Any failure (verifier down, stale,
//     another chain, a proof it cannot check) THROWS: the provider is then not qualified and no on-chain attestation is
//     signed. There is no provider client, no fallback and no quorum beside it, so a mixed selection is refused:
//     --rpc (a provider) or --independent (its agreed RPC quorum is another authority) together with the verifier.
import {base} from 'viem/chains';
import {createChainAuthority} from './chain-authority.mjs';

export function qualifierChainAuthority({authority, verifier, rpc = [], independent = false, chainId = 8453,
  createAuthority = createChainAuthority, maxHeadAgeMs} = {}) {
  if (authority === undefined || authority === null || authority === '' || authority === 'quorum') {
    if (verifier) throw new Error('--chain-verifier is set but --chain-authority is not verifier');
    return null;
  }
  if (authority !== 'verifier') throw new Error('--chain-authority must be quorum or verifier');
  if (!verifier) throw new Error('--chain-authority verifier needs --chain-verifier (the local verifier URL)');
  if (rpc.length) throw new Error('--rpc is not used with --chain-authority verifier (one explicit authority, no provider fallback): remove it');
  if (independent) throw new Error('--independent reads through its agreed RPC quorum, another authority: it is not combined with --chain-authority verifier');
  if (chainId !== base.id) throw new Error(`--chain-authority verifier serves Base (${base.id}) only, not chain ${chainId}`);
  const a = createAuthority({verifier, chain: base, ...(maxHeadAgeMs !== undefined ? {maxHeadAgeMs} : {})});
  const gate = async (what) => {
    await a.actionGate({what});                       // fresh signed head, else throws (chain_stale / chain_unavailable / ...)
    const id = Number(BigInt(await a.client.request({method: 'eth_chainId'})));
    if (id !== chainId) throw Object.assign(new Error(`${what} not done: the local verifier follows chain ${id}, not ${chainId}`), {code: 'chain_wrong_chain', status: 503});
  };
  return Object.freeze({
    mode: 'verifier',
    describe: () => ({...a.describe(), attested: false}),
    readContract: async (q) => { await gate('checker chain read'); return a.client.readContract(q); },
  });
}
