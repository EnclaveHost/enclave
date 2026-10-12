// Network policy v5: the owner's choice of how an app reaches the internet (docs/design/enclave-network.md).
// Signed by the deployment owner (EOA, or ERC-1271 for passkey vaults through `verify`), strictly versioned by nonce.
import {canonical,recordHash} from './route-record.mjs';
import {recoverMessageAddress} from 'viem';

export const MODES=['enclave-network','byo-wireguard','direct'];
const app=/^0x[0-9a-f]{64}$/,hex64=/^[0-9a-f]{64}$/,U6=1e15;
const keys=(o,allowed,required=allowed)=>{
 if(!o||typeof o!=='object'||Array.isArray(o)||Object.getPrototypeOf(o)!==Object.prototype)return false;
 const k=Object.keys(o);return k.every(x=>allowed.includes(x))&&required.every(x=>k.includes(x));
};
const amount=v=>Number.isSafeInteger(v)&&v>=0&&v<=U6;

export function defaultNetworkPolicy(deploymentId){
 if(!app.test(deploymentId||''))throw new Error('invalid deployment id');
 return {version:5,deploymentId,nonce:0,issuedAt:0,mode:'enclave-network',fallback:'none',enclaveNetwork:{routes:2,guard:true,maxPricePerGiB6:0,budget6:0}};
}

export function validateNetworkPolicy(p){
 const base=['version','deploymentId','nonce','issuedAt','mode','fallback'];
 if(!keys(p,[...base,'enclaveNetwork','byo','direct'],base)||p.version!==5||!app.test(p.deploymentId)||
    !Number.isSafeInteger(p.nonce)||p.nonce<0||!Number.isSafeInteger(p.issuedAt)||p.issuedAt<0||!MODES.includes(p.mode)||
    !['none','enclave-network'].includes(p.fallback))throw new Error('invalid network policy');
 if(p.mode==='enclave-network'&&p.fallback!=='none')throw new Error('the Enclave network has no fallback');
 const usesNetwork=p.mode==='enclave-network'||p.fallback==='enclave-network'||(p.mode==='byo-wireguard'&&p.byo?.ingress==='enclave-network');
 if(usesNetwork!==('enclaveNetwork' in p))throw new Error(usesNetwork?'Enclave network settings required':'unused Enclave network settings');
 if(usesNetwork){const n=p.enclaveNetwork;
  if(!keys(n,['routes','guard','maxPricePerGiB6','budget6'])||![1,2].includes(n.routes)||n.guard!==true||!amount(n.maxPricePerGiB6)||!amount(n.budget6)||
     (n.maxPricePerGiB6>0)!==(n.budget6>0))throw new Error('invalid Enclave network settings');}
 if((p.mode==='byo-wireguard')!==('byo' in p))throw new Error('BYO settings belong to byo-wireguard only');
 if(p.mode==='byo-wireguard'&&(!keys(p.byo,['configDigest','ingress'])||!hex64.test(p.byo.configDigest)||!['none','enclave-network'].includes(p.byo.ingress)))throw new Error('invalid BYO settings');
 if((p.mode==='direct')!==('direct' in p))throw new Error('direct settings belong to direct only');
 if(p.mode==='direct'&&(!keys(p.direct,['maxPricePerGiB6'])||!amount(p.direct.maxPricePerGiB6)))throw new Error('invalid direct settings');
 return p;
}

export const networkPolicyMessage=p=>`enclave-network:policy:v5\n${canonical(validateNetworkPolicy(p))}`;
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

// What an app is allowed to use right now, as the host and providers read it.
export function networkUse(p){
 const v=validateNetworkPolicy(p);
 return {
  egress:v.mode,                                                     // where outbound traffic goes
  ingress:v.mode==='byo-wireguard'?v.byo.ingress:v.mode,             // 'enclave-network' | 'direct' | 'none'
  fallback:v.fallback,
  enclaveNetwork:v.enclaveNetwork||null,
 };
}

// A host asking the relay for an app's BYO WireGuard config signs this as the app's runner.
export const byoReleaseMessage=r=>`enclave-network:byo-release:v1\n${canonical(r)}`;
