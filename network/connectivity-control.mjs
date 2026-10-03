// Owner choice is recorded on-chain. Reconstructing it from the quorum lease
// also supports contract wallets; no second EOA-only signature is required.
import {validateDirectPolicy} from './connectivity-policy.mjs';
export function directPolicyFromLease(lease,now=Date.now()) {
 const c=lease?.connectivity;
 if(!c||c.viaTuna||Number(c.expires)<=0||c.owner.toLowerCase()!==lease.owner.toLowerCase())return null;
 return validateDirectPolicy({version:3,deploymentId:lease.id,mode:'direct',directFallback:false,routes:1,
  maxPricePerGiB6:String(c.maxPricePerGiB6),budget6:String(c.budget6),nonce:String(c.nonce),
  connectivity:c.address.toLowerCase(),expiresAt:Number(c.expires)*1000});
}
export function assertDirectChoice(policy,lease,now=Date.now()) {
 const current=directPolicyFromLease(lease,now);
 if(!current||current.expiresAt<=now||Object.keys(current).some(k=>current[k]!==policy[k]))throw Error('direct route differs from current owner authorization');
 return current;
}
