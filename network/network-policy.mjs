// Network policy v5: the owner's choice of how an app reaches the internet (docs/design/enclave-network.md).
// Signed by the deployment owner (EOA, or ERC-1271 for passkey vaults through `verify`), strictly versioned by nonce.
import {recordHash} from './route-record.mjs';
import {recoverMessageAddress} from 'viem';
import {validateNetworkPolicy,networkPolicyMessage} from './network-policy-core.mjs';
export * from './network-policy-core.mjs';
export const networkPolicyHash=p=>recordHash(validateNetworkPolicy(p));

export async function signNetworkPolicy(account,policy){
 return {policy,signature:await account.signMessage({message:networkPolicyMessage(policy)})};
}

// verify(owner,message,signature) -> boolean lets a caller with a chain client accept ERC-1271 owners; without it
// only an EOA signature from the owner is accepted.
export async function verifyNetworkPolicy(envelope,{owner,deploymentId,verify}={}){
 const p=validateNetworkPolicy(envelope?.policy);
 if(deploymentId&&p.deploymentId!==deploymentId)throw new Error('network policy is for another app');
 if(typeof envelope.signature!=='string'||!/^0x[0-9a-fA-F]+$/.test(envelope.signature)||envelope.signature.length>8192)throw new Error('network policy signature required');
 const message=networkPolicyMessage(p);
 let ok=false;
 if(verify)ok=await verify(owner,message,envelope.signature);
 else{try{ok=(await recoverMessageAddress({message,signature:envelope.signature})).toLowerCase()===String(owner).toLowerCase();}catch{ok=false;}}
 if(!ok)throw new Error('network policy requires the deployment owner signature');
 return p;
}

// The highest nonce wins; an older or equal one is stale (or a replay). memory: {get(id)->nonce|undefined, set(id,nonce)}.
export async function admitNetworkPolicy(envelope,{owner,deploymentId,verify,memory}){
 const p=await verifyNetworkPolicy(envelope,{owner,deploymentId,verify});
 const seen=await memory.get(p.deploymentId);
 if(seen!==undefined&&p.nonce<seen)throw new Error('stale network policy');
 if(seen===undefined||p.nonce>seen)await memory.set(p.deploymentId,p.nonce);
 return p;
}

