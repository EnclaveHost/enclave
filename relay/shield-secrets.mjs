// Sealed secret delivery to a deployment-bound Shield guest. The host handles ciphertext only.
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {endpointOperator,recoverOp,makeReplayCache,holdsLease} from './fleet-auth.js';
import {expectedShieldApp} from './shield-app-verifier.mjs';
import {releaseConfig,sealRelease,signResponse,keyIdOf,ed25519RawPublic} from './secrets-release.mjs';
export const secretRequestMessage=(id,endpoint,ts)=>`enclave-shield-secrets:${id}:${endpoint}:${ts}`;
const fingerprint=d=>JSON.stringify([d.id,d.owner,d.runner,d.appRef,d.configCid,d.active,d.isPublic,Number(d.cpuMilli),Number(d.gpuMilli)]);
const err=(message,status=403)=>Object.assign(new Error(message),{status});
export function createShieldSecretRelease({hub,policyFile='',policy:supplied,confirmRow,readCatalog,readConfig,fetchVerified,hostForEndpoint,isOwnerDeployment=()=>false,custodyRefusal=async()=>null,signingKey=()=>releaseConfig().signingKey,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
 const policy=supplied||(policyFile?JSON.parse(fs.readFileSync(policyFile,'utf8')):null),fresh=makeReplayCache();
 let active=0;const inflight=new Set();
 return async function deliver(b,ctx,read){
  const id=String(b?.id||''),endpoint=String(b?.endpoint||'').replace(/\/+$/,'');const ts=Number(b?.ts);
  if(!/^0x[0-9a-f]{64}$/.test(id)||!/^https:\/\//.test(endpoint)||!Number.isSafeInteger(ts)||Math.abs(Date.now()/1000-ts)>120)throw err('invalid release request',422);
  if(policy?.cpu?.secretsV1!==true)throw err('Shield secret release is disabled',503);
  const key=signingKey();if(!key)throw err('release signing key unavailable',503);
  const op=await endpointOperator(ctx,endpoint),signer=await recoverOp(secretRequestMessage(id,endpoint,ts),b.opSig);
  if(!op||!signer||op!==signer)throw err('operator signature refused');
  if(!fresh(b.opSig,ts+120))throw err('release request replayed',409);
  const epId=await ctx.endpointIdOf(endpoint),host=hostForEndpoint(epId);
  if(!host||host.mode!=='hv-node'||!policy.hosts?.includes(host.name))throw err('no admitted Shield host');
  const sid=hub.shieldSessionId(host.name);if(!sid)throw err('no authenticated Shield session');
  if(active>=2||inflight.has(id))throw err('release busy',429);
  active++;inflight.add(id);
  try{
   const row=await confirmRow(id);
   if(!row?.active||!row.isPublic||Number(row.gpuMilli)!==0||!holdsLease(row,epId))throw err('deployment is not public CPU work leased to this host');
   // sessions custody (docs/design/sessions.md §7): a vault-held prod record releases only what its owner promoted
   const custody=await custodyRefusal(row);
   if(custody)throw err(custody,403);
   const expected=await expectedShieldApp(row,{policy,readCatalog,readConfig,fetchVerified,secretsRequired:true,allowPendingOwner:isOwnerDeployment(host,row)});
   const nonce=randomBytes(32),origin=`tunnel://${host.name}`;
   // Readiness and privacy admission share the node's bounded proof service.
   // Retry a busy/startup response with the SAME challenge; never read secrets
   // or relax verification when evidence is unavailable.
   let proof;
   for(let attempt=0;attempt<3;attempt++){
    if(attempt)await sleep(1500+Math.floor(Math.random()*2500));
    proof=await hub.fetchJson(origin,`/v1/shield/secret-evidence?deployment=${id}&nonce=${nonce.toString('hex')}`);
    if(proof?.purpose==='enclave-shield-secrets/1'&&proof.id===id&&typeof proof.sealKey==='string'&&proof.sealKey.length===44&&typeof proof.handshakeSpki==='string'&&proof.handshakeSpki.length<=5500)break;
    proof=null;
   }
   if(!proof)throw err('no bounded secret-release proof',503);
   const sealKey=Buffer.from(proof.sealKey,'base64');if(sealKey.length!==32)throw err('invalid guest seal key');
   const verified=await hub.verifyShieldApp(host.name,{doc:proof.doc,handshakeSpki:Buffer.from(proof.handshakeSpki,'base64'),nonce,
    expectedAppSha256:expected.appSha256,expectedRuntimeId:expected.runtimeId,requiresConfigBundleV5:true,requiresSecretsV1:true,requiresConfigSocketServer:expected.requiresConfigSocketServer,
    shieldRelease:{purpose:proof.purpose,id,sealKey}},policy);
   if(!verified?.ok)throw err(`guest release proof refused: ${verified?.reason||'no verdict'}`);
   const current=await confirmRow(id);
   if(fingerprint(current)!==fingerprint(row)||!holdsLease(current,epId)||hub.shieldSessionId(host.name)!==sid)throw err('deployment or host session changed during release');
   const {env,rev}=read(id); // No secret bytes are read until every authorization and attestation check passes.
   const plaintext=Buffer.from(JSON.stringify({id,config:null,secrets:env,issuedAt:new Date().toISOString()}));
   if(plaintext.length>40000)throw err('secret payload exceeds release bound',422);
   let sealed;try{sealed=sealRelease({id,ticket:nonce,sealKey,plaintext});}finally{plaintext.fill(0);}
   const sig=signResponse(key,{id,ticket:nonce,sealKey,sealed}),keyId=keyIdOf(ed25519RawPublic(key));
   const response=await hub.request(origin,{method:'POST',path:'/v1/shield/secret-install',headers:{'content-type':'application/json'},
    body:Buffer.from(JSON.stringify({id,nonce:nonce.toString('hex'),sealed:sealed.toString('base64'),sig:sig.toString('base64'),keyId}))});
   if(response.status!==200||JSON.parse(response.body.toString())?.ok!==true)throw err('guest did not accept the sealed release',503);
   return {ok:true,id,appId:expected.appSha256,rev,count:Object.keys(env).length};
  }finally{active--;inflight.delete(id);}
 };
}
