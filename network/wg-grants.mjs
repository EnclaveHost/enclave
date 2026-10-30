// The host's side of the provider control protocol (docs/design/enclave-network.md): ask a provider for a peer as the
// deployment's runner, and accept a grant only when the provider's operator signed it for exactly what was asked.
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {recoverMessageAddress} from 'viem';
import {peerRequestMessage,grantMessage,revokeMessage} from './wg-provider/provider.mjs';

export function wireGuardKeypair(){
 const {privateKey,publicKey}=generateKeyPairSync('x25519');
 return {privateKey:privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('base64'),publicKey:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')};
}

export class WgGrants {
 // account: the runner's registry operator; runner: its registry id; policy(id) -> owner-signed envelope|null
 constructor({account,runner,policy=async()=>null,fetch=globalThis.fetch,now=Date.now,timeoutMs=15000}){Object.assign(this,{account,runner,policy,fetch,now,timeoutMs});}
 // provider: a verified directory record; url: where its control API is reachable (direct, or a loopback forward
 // through the guard); role: 'guard'|'exit'
 // rpc: a service request of a host that serves its public RPC origin (the exit then grants rpc-<b32> too; absent otherwise)
 async request({provider,url,role,deploymentId,wgPublicKey,ingress=false,egress=false,rpc=false}){
  const now=this.now();
  const request={version:1,providerId:provider.providerId,role,deploymentId,runner:this.runner,wgPublicKey,policy:await this.policy(deploymentId),
   ingress:role!=='guard'&&ingress,egress:role!=='guard'&&egress,issuedAt:now,nonce:randomBytes(16).toString('hex'),expiresAt:now+10*60000,...(role==='service'&&rpc===true?{rpc:true}:{})};
  const signature=await this.account.signMessage({message:peerRequestMessage(request)});
  // no answer at all (refused, reset, timed out) is marked: a renewal tries again while its grant lasts, where a
  // provider's answer stands
  const res=await this.fetch(url.replace(/\/$/,'')+'/v1/peer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request,signature}),signal:AbortSignal.timeout(this.timeoutMs)})
   .catch(e=>{throw Object.assign(new Error(`${role} provider ${provider.address}: no answer (${e?.cause?.code||e?.cause?.message||e?.name||e?.message})`),{providerRole:role==='guard'?'guard':'public',unanswered:true});});
  let body;try{body=await res.json();}catch{throw new Error(`${role} provider ${provider.address}: HTTP ${res.status}`);}
  if(!res.ok)throw Object.assign(new Error(`${role} provider ${provider.address}: ${body?.error||res.status}`),{providerRole:role==='guard'?'guard':'public',refused:res.status===403});
  return this.verify(body,{provider,role,request});
 }
 // withdraw this host's own service/control peer (wg-provider/provider.mjs revoke): signed by the registry operator
 async revoke({provider,url,wgPublicKey}){
  const request={version:1,providerId:provider.providerId,runner:this.runner,wgPublicKey,issuedAt:this.now(),nonce:randomBytes(16).toString('hex')};
  const signature=await this.account.signMessage({message:revokeMessage(request)});
  const res=await this.fetch(url.replace(/\/$/,'')+'/v1/revoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request,signature}),signal:AbortSignal.timeout(this.timeoutMs)});
  let body;try{body=await res.json();}catch{throw new Error(`revoke at ${provider.address}: HTTP ${res.status}`);}
  if(!res.ok||body?.revoked!==true)throw new Error(`revoke at ${provider.address}: ${body?.error||res.status}`);
  return body;
 }
 async verify(env,{provider,role,request}){
  const g=env?.grant;
  if(!g||typeof env.signature!=='string')throw new Error('grant missing');
  const signer=(await recoverMessageAddress({message:grantMessage(g),signature:env.signature})).toLowerCase();
  const key=role==='guard'?provider.wgGuardKey:provider.wgExitKey,port=role==='guard'?provider.ports.guard:provider.ports.exit;
  // role 'exit' (an app's route), 'control' (the host's own traffic) or 'service' (its public roles) land on the exit interface
  if(signer!==provider.operator||g.version!==1||g.providerId!==provider.providerId||g.role!==role||g.deploymentId!==request.deploymentId||
     g.clientPublicKey!==request.wgPublicKey||g.providerPublicKey!==key||g.endpoint!==`${provider.address}:${port}`||
     !/^10\.7[78]\.\d{1,3}\.\d{1,3}$/.test(g.clientAddress||'')||!Array.isArray(g.names)||!(g.expiresAt>this.now()))throw new Error(`${role} grant does not match what was asked`);
  return g;
 }
}
