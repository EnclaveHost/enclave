// Read at the exact block used by LeaseReader; it includes this data in the
// quorum comparison. A local owner-policy file cannot override revocation.
import {parseAbi} from 'viem';
import {hostABI} from './registry-abi.mjs';
export const connectivityABI=parseAbi([
 'function registry() view returns (address)',
 'function viaTuna(bytes32) view returns (bool)',
 'function tunaProviders(bytes32) view returns (bytes32[])',
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
    const [policy,host,capabilities,viaTuna]=await Promise.all([read('policies',[row.id]),read('hosts',[row.runner]),read('capabilities',[row.runner]),read('viaTuna',[row.id])]);
    const providers=[];
    if(viaTuna){
      const [ids,registry]=await Promise.all([read('tunaProviders',[row.id]),read('registry')]);
      if(ids.length<1||ids.length>6||new Set(ids.map(id=>id.toLowerCase())).size!==ids.length)throw Error('invalid authorized provider path');
      providers.push(...await Promise.all(ids.map(async id=>{
        const [h,c,key]=await Promise.all([read('hosts',[id]),read('capabilities',[id]),client.readContract({address:registry,abi:hostABI,functionName:'get',args:[id],blockNumber})]);
        return {id:id.toLowerCase(),qualified:c[1],pricePerGiB6:h[2],qualifiedUntil:h[3],addressHash:h[4],operator:key.operator,proofKey:key.proofKey,active:key.active};
      })));
    }
    const [owner,nonce,expires,maxPricePerGiB6,budget6,spent6,providerBps]=policy;
    return {...row,connectivity:{address:address.toLowerCase(),owner,nonce,expires,maxPricePerGiB6,budget6,spent6,providerBps,
      viaTuna,providers,direct:capabilities[0],tunaProvider:capabilities[1],pricePerGiB6:host[2],qualifiedUntil:host[3],addressHash:host[4],operator:host[5]}};
  }));
}
