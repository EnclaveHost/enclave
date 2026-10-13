import {keccak256,stringToHex} from 'viem';
const id=/^0x[0-9a-f]{64}$/,uint=/^(0|[1-9][0-9]{0,23})$/;
export function validateTunaPolicy(p){
 const fields=['version','deploymentId','mode','currency','directFallback','routes','maxPricePerGiB6','budget6','nonce','connectivity','expiresAt','providerIds','diversity','providers'];
 if(!p||p.version!==4||!id.test(p.deploymentId||'')||p.mode!=='guarded'||p.currency!=='USDC'||p.directFallback!==false||p.routes!==2||
  !['maxPricePerGiB6','budget6','nonce'].every(k=>uint.test(p[k]||'')&&BigInt(p[k])>0n)||!/^0x[0-9a-f]{40}$/.test(p.connectivity||'')||
  !Number.isSafeInteger(p.expiresAt)||p.expiresAt<=0||p.diversity!=='beneficiary-and-network'||!Array.isArray(p.providerIds)||p.providerIds.length<1||p.providerIds.length>6||
  p.providerIds.some(v=>!id.test(v))||new Set(p.providerIds).size!==p.providerIds.length||Object.keys(p).some(k=>!fields.includes(k)))throw Error('invalid owner USDC TUNA policy');
 // The owner pins registry identities on chain. NKN keys may rotate only when
 // their new encrypted connection is authenticated by the registered proof key.
 const providers=Object.fromEntries(['guard','public','egress'].map(role=>[role,{allow:[],prefer:[],deny:[]}]));
 if(p.providers&&JSON.stringify(p.providers)!==JSON.stringify(providers))throw Error('USDC provider policy must use the owner-authorized registry identities');
 return {...p,providers};
}
export function tunaPolicyFromLease(lease){
 const c=lease?.connectivity;if(!c?.viaTuna||c.owner.toLowerCase()!==lease.owner.toLowerCase())throw Error('current USDC TUNA owner authorization required');
 if(!Array.isArray(c.providers))throw Error('USDC TUNA provider path required');
 return validateTunaPolicy({version:4,deploymentId:lease.id,mode:'guarded',currency:'USDC',directFallback:false,routes:2,maxPricePerGiB6:String(c.maxPricePerGiB6),budget6:String(c.budget6),nonce:String(c.nonce),connectivity:c.address.toLowerCase(),expiresAt:Number(c.expires)*1000,providerIds:c.providers.map(p=>p.id),diversity:'beneficiary-and-network'});
}
export function tunaInventoryForLease(nodes,lease,policy,now=Date.now()){
 let p;try{p=tunaPolicyFromLease(lease);}catch{return [];}
 if(!lease.active||lease.validUntil<=now||lease.leaseUntil<=now||p.expiresAt<=now||['nonce','connectivity','maxPricePerGiB6','budget6','expiresAt'].some(k=>p[k]!==policy[k])||JSON.stringify(p.providerIds)!==JSON.stringify(policy.providerIds))return [];
 const c=lease.connectivity;if(c.providers.reduce((n,p)=>n+BigInt(p.pricePerGiB6),0n)>BigInt(p.maxPricePerGiB6)||BigInt(lease.bandwidthBackingRequired6??'-1')!==0n)return [];
 return nodes.flatMap(n=>{
  const provider=c.providers.find(p=>p.id===n.registryId);
  if(n.currency!=='USDC'||!provider?.qualified||!provider.active||Number(provider.qualifiedUntil)*1000<=now||String(provider.pricePerGiB6)!==n.pricePerGiB6||provider.addressHash!==keccak256(stringToHex(n.address)))return [];
  return [{...n,nknBeneficiary:n.beneficiary,beneficiary:provider.operator.toLowerCase(),onChainQualified:true}];
 });
}
