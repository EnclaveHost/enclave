// The relay's side of the Enclave network (docs/design/enclave-network.md). Storage and lookup only: providers,
// hosts and the Network tab verify every signature themselves.
//
//   GET  /v1/network/providers                   provider records + current qualifications (and the trusted checkers)
//   POST /v1/network/providers                   {record, signature}           a provider's signed opt-in
//   POST /v1/network/qualifications              {qualification, signature}    a trusted checker's verdict
//   GET  /v1/network/policy/:id                  {envelope|null}               the owner's newest v5 policy
//   POST /v1/network/policy/:id                  {envelope}                    set it (owner signature, higher nonce)
//   POST /v1/network/byo/:id                     {config, salt, expiry, signature}   store a BYO WireGuard config (owner)
//   POST /v1/network/byo/:id/view|delete         {expiry, signature}           the owner's redacted view / removal
//   POST /v1/network/byo/:id/release             {request, signature}          the config, to the current runner only
//   GET  /v1/network/status/:id                  what the Network tab shows: policy, routes, the host's circuit report
//
// A BYO config is sealed at rest (AES-256-GCM under a key derived from SECRETS_KEY, AAD = deployment id) and is never
// logged, put in a route, a provider record or a public response; only its salted digest is public (in the policy).
import {createCipheriv,createDecipheriv,createHmac,randomBytes,createHash} from 'node:crypto';
import {verifyProviderRecord,validateQualification,qualificationMessage,eligibleProviders} from '../network/provider-directory.mjs';
import {verifyNetworkPolicy,validateNetworkPolicy,defaultNetworkPolicy,byoReleaseMessage,byoConfigMessage,byoOwnerMessage} from '../network/network-policy.mjs';
import {parseWireGuardConfig,redactWireGuardConfig,wireGuardConfigDigest} from '../network/wg-config.mjs';
import {verifyOwnerSignature} from '../network/owner-signature.mjs';
import {canonical} from '../network/route-record.mjs';
import {recoverMessageAddress} from 'viem';

export {byoConfigMessage,byoOwnerMessage};
const ID=/^0x[0-9a-f]{64}$/,SIG_TTL=600;

// JsonStore, file and clients come from the relay (relay/store.js), so this module bundles without relay internals.
export function createNetworkApi({checkers=[],addressBook,clients:clientsFn=async()=>[],JsonStore,file,secretsKey=process.env.SECRETS_KEY,now=Date.now,log=()=>{}}={}){
 const store=new JsonStore(file,{version:1,providers:{},policies:{},byo:{},status:{}},{durable:true});
 const key=secretsKey&&/^[0-9a-f]{64}$/i.test(secretsKey.trim())?createHmac('sha256',Buffer.from(secretsKey.trim(),'hex')).update('enclave-network byo v1').digest():null;
 const seal=(id,obj)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});c.setAAD(Buffer.from(id));return Buffer.concat([iv,c.update(JSON.stringify(obj),'utf8'),c.final(),c.getAuthTag()]).toString('base64');};
 const open=(id,blob)=>{const b=Buffer.from(blob,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12),{authTagLength:16});d.setAAD(Buffer.from(id));d.setAuthTag(b.subarray(b.length-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,b.length-16)),d.final()]).toString('utf8'));};
 const seen=new Map();const fresh=sig=>{const t=now();for(const [k,v] of seen)if(v<t)seen.delete(k);if(seen.has(sig))return false;seen.set(sig,t+2*SIG_TTL*1000);return true;};
 const verifyOwner=async(owner,message,signature)=>verifyOwnerSignature({clients:await clientsFn(),owner,message,signature,addressBook});
 const trusted=checkers.map(c=>c.toLowerCase());

 async function providers(){
  const t=now(),out=[];
  for(const [pid,e] of Object.entries(store.data.providers)){if(e.record.record.expiresAt<=t){delete store.data.providers[pid];store.saveSoon();continue;}
   // every trusted checker's latest verdict; `qualification` (the newest) for hosts that read one
   const all=Object.values(e.byChecker||{});const newest=all.sort((a,b)=>b.qualification.issuedAt-a.qualification.issuedAt)[0]||e.qualification||null;
   out.push({record:e.record,qualifications:all.length?all:e.qualification?[e.qualification]:[],qualification:newest});}
  return out;
 }
 // the relay's own verified view (for route acceptance); hosts compute theirs independently
 async function eligible(){return eligibleProviders(await providers(),{checkers:trusted,now:now(),log});}
 function currentPolicy(id){const e=store.data.policies[id];return e?validateNetworkPolicy(e.policy):defaultNetworkPolicy(id);}

 async function ownerOf(ctx,id){const rows=await ctx.ledgerRows();const d=rows.find(r=>String(r.id).toLowerCase()===id);return d||null;}
 // owner-signed request: {expiry, signature}; message built by the caller from what is being authorized
 async function ownerSigned(ctx,id,b,message){
  const expiry=Number(b.expiry),t=Math.floor(now()/1000);
  if(!Number.isSafeInteger(expiry)||expiry<t||expiry>t+SIG_TTL)throw Object.assign(new Error(`expiry must be within ${SIG_TTL/60} minutes`),{status:422});
  const d=await ownerOf(ctx,id);if(!d)throw Object.assign(new Error('deployment not found'),{status:404});
  if(!await verifyOwner(String(d.owner),message,String(b.signature||'')))throw Object.assign(new Error('the signer does not own this deployment'),{status:403});
  if(!fresh(String(b.signature)))throw Object.assign(new Error('signature already used'),{status:409});
  return d;
 }

 async function handle(req,res,u,ctx){
  const send=(status,body)=>ctx.json(res,status,body,req);
  const body=async(max=16384)=>{try{return JSON.parse((await ctx.readBody(req,max)).toString()||'{}');}catch(e){throw Object.assign(new Error('JSON body required'),{status:400});}};
  try{
   const p=u.pathname;
   if(p==='/v1/network/providers'&&req.method==='GET')return send(200,{providers:await providers(),checkers:trusted});
   if(p==='/v1/network/providers'&&req.method==='POST'){
    const env=await body();
    const r=await verifyProviderRecord(env,{now:now(),hostOperator:ctx.hostOperator});
    const old=store.data.providers[r.providerId];
    if(old&&old.record.record.issuedAt>=r.issuedAt)return send(409,{error:'stale provider record'});
    if(!old&&Object.keys(store.data.providers).length>=4096)return send(429,{error:'provider directory full'});
    // a qualification binds address and keys: it survives a re-publication only if those did not change
    const same=q=>q&&q.address===r.address&&q.wgExitKey===r.wgExitKey&&q.wgGuardKey===r.wgGuardKey;
    const byChecker=Object.fromEntries(Object.entries(old?.byChecker||{}).filter(([,v])=>same(v.qualification)));const keep=Object.keys(byChecker).length>0;
    store.data.providers[r.providerId]={record:{record:r,signature:env.signature},byChecker};store.saveSoon();
    return send(200,{ok:true,providerId:r.providerId,qualified:!!keep});
   }
   if(p==='/v1/network/qualifications'&&req.method==='POST'){
    const env=await body();const q=validateQualification(env?.qualification);
    const signer=(await recoverMessageAddress({message:qualificationMessage(q),signature:env.signature})).toLowerCase();
    if(!trusted.includes(signer)||signer===q.operator)return send(403,{error:'not a trusted checker'});
    const e=store.data.providers[q.providerId];if(!e)return send(404,{error:'unknown provider'});
    const r=e.record.record;if(r.address!==q.address||r.wgExitKey!==q.wgExitKey||r.wgGuardKey!==q.wgGuardKey||r.operator!==q.operator)return send(409,{error:'qualification does not match the current provider record'});
    e.byChecker||={};
    if(e.byChecker[signer]&&e.byChecker[signer].qualification.issuedAt>=q.issuedAt)return send(409,{error:'stale qualification'});
    e.byChecker[signer]={qualification:q,signature:env.signature};delete e.qualification;store.saveSoon();
    return send(200,{ok:true,passed:Object.values(q.checks).every(Boolean)});
   }
   let m=p.match(/^\/v1\/network\/policy\/(0x[0-9a-fA-F]{64})$/);
   if(m){const id=m[1].toLowerCase();
    if(req.method==='GET'){const e=store.data.policies[id];return send(200,{envelope:e||null,policy:currentPolicy(id)});}
    if(req.method!=='POST')return send(405,{error:'GET or POST'});
    const {envelope}=await body();const d=await ownerOf(ctx,id);if(!d)return send(404,{error:'deployment not found'});
    const policy=await verifyNetworkPolicy(envelope,{owner:String(d.owner),deploymentId:id,verify:verifyOwner});
    const old=store.data.policies[id];if(old&&policy.nonce<=old.policy.nonce)return send(409,{error:`nonce must be above ${old.policy.nonce}`});
    if(policy.mode==='byo-wireguard'&&store.data.byo[id]?.digest!==policy.byo.configDigest)return send(409,{error:'upload the BYO WireGuard config this policy names first'});
    store.data.policies[id]={policy,signature:envelope.signature};store.saveSoon();log(`network policy ${id.slice(0,10)}: ${policy.mode} nonce ${policy.nonce}`);
    return send(200,{ok:true,policy});
   }
   m=p.match(/^\/v1\/network\/byo\/(0x[0-9a-fA-F]{64})(?:\/(view|delete|release))?$/);
   if(m&&req.method==='POST'){const id=m[1].toLowerCase(),action=m[2]||'put';
    if(!key)return send(503,{error:'BYO WireGuard storage is not configured on this relay'});
    const b=await body();
    if(action==='put'){
     let parsed;try{parsed=parseWireGuardConfig(String(b.config||''));}catch(e){return send(422,{error:'invalid WireGuard config',problems:e.problems||[e.message]});}
     if(!/^[0-9a-f]{64}$/.test(b.salt||''))return send(422,{error:'32-byte hex salt required'});
     const digest=await wireGuardConfigDigest(b.salt,parsed.config);
     await ownerSigned(ctx,id,b,byoConfigMessage({deploymentId:id,configDigest:digest,expiry:Number(b.expiry)}));
     store.data.byo[id]={digest,blob:seal(id,{config:String(b.config),salt:b.salt}),redacted:redactWireGuardConfig(parsed.config),updatedAt:now()};store.saveSoon();
     return send(200,{ok:true,configDigest:digest,redacted:store.data.byo[id].redacted,warnings:parsed.warnings});
    }
    if(action==='view'||action==='delete'){
     await ownerSigned(ctx,id,b,byoOwnerMessage({deploymentId:id,action,expiry:Number(b.expiry)}));
     const e=store.data.byo[id];if(action==='delete'){delete store.data.byo[id];store.saveSoon();return send(200,{ok:true,deleted:!!e});}
     return send(200,e?{configDigest:e.digest,redacted:e.redacted,updatedAt:e.updatedAt}:{configDigest:null});
    }
    // release: the deployment's current runner only, fresh and single-use
    const r=b.request;
    if(!r||r.version!==1||r.deploymentId!==id||!ID.test(r.runner||'')||!/^[0-9a-f]{32}$/.test(r.nonce||'')||!Number.isSafeInteger(r.issuedAt)||Math.abs(now()-r.issuedAt)>60000)return send(422,{error:'invalid release request'});
    const signer=(await recoverMessageAddress({message:byoReleaseMessage(r),signature:b.signature}).catch(()=>'')).toLowerCase();
    const d=await ownerOf(ctx,id);
    if(!d||String(d.runner).toLowerCase()!==r.runner||String(d.runnerOperator).toLowerCase()!==signer||Number(d.leaseUntil)*1000<=now())return send(403,{error:'only the deployment\'s current runner may receive its config'});
    if(!fresh(r.nonce))return send(409,{error:'replayed release request'});
    const e=store.data.byo[id];if(!e)return send(404,{error:'no BYO WireGuard config on record'});
    return send(200,open(id,e.blob));
   }
   m=p.match(/^\/v1\/network\/status\/(0x[0-9a-fA-F]{64})$/);
   if(m&&req.method==='GET'){const id=m[1].toLowerCase();
    const e=store.data.policies[id],s=store.data.status[id];
    return send(200,{policy:currentPolicy(id),policySet:!!e,byoConfig:store.data.byo[id]?{configDigest:store.data.byo[id].digest,updatedAt:store.data.byo[id].updatedAt}:null,
     host:s&&s.at>now()-120000?s.status:null,hostReportedAt:s?.at||null,providers:(await eligible()).map(x=>({providerId:x.providerId,address:x.address,region:x.region,kind:x.kind,roles:x.eligibleRoles,pricePerGiB6:x.pricePerGiB6,qualifiedUntil:x.qualifiedUntil}))});
   }
   return send(404,{error:'not found'});
  }catch(e){if(e.status!==404)log('network api: '+e.message);return send(e.status||400,{error:e.message});}
 }
 // the host's own report for the Network tab, carried in its route publication (bounded; no secrets in it)
 function noteStatus(id,status){
  if(!ID.test(id)||!status||typeof status!=='object')return;
  const s=JSON.stringify(status);if(s.length>8192)return;
  store.data.status[id]={at:now(),status:JSON.parse(s)};store.saveSoon();
 }
 return {handle,eligible,currentPolicy,noteStatus,providers,store,checkers:trusted};
}
