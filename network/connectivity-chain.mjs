// Read at the exact block used by LeaseReader; it includes this data in the
// quorum comparison. A local owner-policy file cannot override revocation.
import {parseAbi} from 'viem';
export const connectivityABI=parseAbi([
 'function ledger() view returns (address)',
 'function policies(bytes32) view returns (address owner,uint64 nonce,uint64 expires,uint64 maxPricePerGiB6,uint128 budget6,uint128 spent6,uint16 providerBps)',
 'function hosts(bytes32) view returns (bool direct,bool tuna,uint64 pricePerGiB6,uint64 qualifiedUntil,bytes32 addressHash,address operator,address qualifier)',
 'function capabilities(bytes32) view returns (bool direct,bool tuna)',
]);
export async function readConnectivity(client,{address,deployments,rows,blockNumber}) {
  if(!/^0x[0-9a-f]{40}$/i.test(address||'')||/^0x0{40}$/i.test(address))throw Error('connectivity contract required');
  const read=(functionName,args=[])=>client.readContract({address,abi:connectivityABI,functionName,args,blockNumber});
  if((await read('ledger')).toLowerCase()!==deployments.toLowerCase())throw Error('connectivity ledger mismatch');
  return Promise.all(rows.map(async row=>{
    const [policy,host,capabilities]=await Promise.all([read('policies',[row.id]),read('hosts',[row.runner]),read('capabilities',[row.runner])]);
    const [owner,nonce,expires,maxPricePerGiB6,budget6,spent6,providerBps]=policy;
    return {...row,connectivity:{address:address.toLowerCase(),owner,nonce,expires,maxPricePerGiB6,budget6,spent6,providerBps,
      direct:capabilities[0],tunaProvider:capabilities[1],pricePerGiB6:host[2],qualifiedUntil:host[3],addressHash:host[4],operator:host[5]}};
  }));
}
