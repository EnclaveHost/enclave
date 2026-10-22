// ROOT-RUN, READ-ONLY chain read (review 9d R11): the deployments ledger size the challenge replica must index before it is
// "ready" (createLedgerIndex: one sync reads at most 16 x 128 = 2048 ids, later syncs every 60 s; readiness waits 60 s).
// node ledger-count.mjs   (from a tree with viem, e.g. work/enclave). Prints per-RPC counts at its latest block; no keys.
import { createPublicClient, http } from 'viem';
const DEPLOYMENTS = '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://base.public.blockpi.network/v1/rpc/public'];
const ABI = [{ type: 'function', name: 'count', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
for (const url of RPCS) {
  try { const c = createPublicClient({ transport: http(url, { timeout: 10_000 }) }); const n = await c.readContract({ address: DEPLOYMENTS, abi: ABI, functionName: 'count' });
        console.log(JSON.stringify({ rpc: url, count: String(n), oneSync: Number(n) <= 2048 })); }
  catch (e) { console.log(JSON.stringify({ rpc: url, error: String(e.shortMessage || e.message).slice(0, 160) })); }
}
