// Network policy v5, the parts the browser shares: validation, the default, the signed message and what a policy
// allows (docs/design/enclave-network.md). Signature checks live in network-policy.mjs.
import {canonical} from './canonical.mjs';

// host: egress leaves through the host's own internet connection (an operator opt-in; no public address needed, unlike
// direct), with ingress either none or on the Enclave network, like BYO
export const MODES=['enclave-network','byo-wireguard','direct','host'];
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
 if(!keys(p,[...base,'enclaveNetwork','byo','direct','host'],base)||p.version!==5||!app.test(p.deploymentId)||
    !Number.isSafeInteger(p.nonce)||p.nonce<0||!Number.isSafeInteger(p.issuedAt)||p.issuedAt<0||!MODES.includes(p.mode)||
    !['none','enclave-network'].includes(p.fallback))throw new Error('invalid network policy');
 if(p.mode==='enclave-network'&&p.fallback!=='none')throw new Error('the Enclave network has no fallback');
 const usesNetwork=p.mode==='enclave-network'||p.fallback==='enclave-network'||(p.mode==='byo-wireguard'&&p.byo?.ingress==='enclave-network')||(p.mode==='host'&&p.host?.ingress==='enclave-network');
 if(usesNetwork!==('enclaveNetwork' in p))throw new Error(usesNetwork?'Enclave network settings required':'unused Enclave network settings');
 if(usesNetwork){const n=p.enclaveNetwork;
  if(!keys(n,['routes','guard','maxPricePerGiB6','budget6'])||![1,2].includes(n.routes)||n.guard!==true||!amount(n.maxPricePerGiB6)||!amount(n.budget6)||
     (n.maxPricePerGiB6>0)!==(n.budget6>0))throw new Error('invalid Enclave network settings');}
 if((p.mode==='byo-wireguard')!==('byo' in p))throw new Error('BYO settings belong to byo-wireguard only');
 if(p.mode==='byo-wireguard'&&(!keys(p.byo,['configDigest','ingress'])||!hex64.test(p.byo.configDigest)||!['none','enclave-network'].includes(p.byo.ingress)))throw new Error('invalid BYO settings');
 if((p.mode==='direct')!==('direct' in p))throw new Error('direct settings belong to direct only');
 if(p.mode==='direct'&&(!keys(p.direct,['maxPricePerGiB6'])||!amount(p.direct.maxPricePerGiB6)))throw new Error('invalid direct settings');
 if((p.mode==='host')!==('host' in p))throw new Error('host settings belong to host only');
 if(p.mode==='host'&&(!keys(p.host,['ingress'])||!['none','enclave-network'].includes(p.host.ingress)))throw new Error('invalid host settings');
 return p;
}

export const networkPolicyMessage=p=>`enclave-network:policy:v5\n${canonical(validateNetworkPolicy(p))}`;

// What an app is allowed to use right now, as the host and providers read it.
export function networkUse(p){
 const v=validateNetworkPolicy(p);
 return {
  egress:v.mode,                                                     // where outbound traffic goes
  ingress:v.mode==='byo-wireguard'?v.byo.ingress:v.mode==='host'?v.host.ingress:v.mode, // 'enclave-network' | 'direct' | 'none'
  fallback:v.fallback,
  enclaveNetwork:v.enclaveNetwork||null,
 };
}

// A host asking the relay for an app's BYO WireGuard config signs this as the app's runner.
export const byoReleaseMessage=r=>`enclave-network:byo-release:v1\n${canonical(r)}`;
// An owner storing, viewing or removing an app's BYO WireGuard config signs one of these (the config itself never
// leaves the browser unencrypted except to the relay, which seals it; only its salted digest is in the policy).
export const byoConfigMessage=v=>`enclave-network:byo-config:v1\n${canonical(v)}`;
export const byoOwnerMessage=v=>`enclave-network:byo-owner:v1\n${canonical(v)}`;
