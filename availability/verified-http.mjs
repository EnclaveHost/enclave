import https from 'node:https';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {verifyShieldAppPolicy} from '../relay/shield-app-policy.mjs';
import {verifyEvidence} from '../verifier/index.mjs';
import {runtimeId,bind2} from '../isolation/contract/runtime.mjs';

function exchange(url,{method='GET',headers={},body,timeoutMs,maxBytes=131072,pinnedSpki}={}) {
 return new Promise((resolve,reject)=>{
  if(url.protocol!=='https:')return reject(new Error('HTTPS required'));
  const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
  const req=https.request(url,{method,agent:false,headers:{...headers,...(bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{})}},res=>{
   const cert=res.socket.getPeerX509Certificate();if(!cert){req.destroy(new Error('no peer certificate'));return;}
   const spki=cert.publicKey.export({format:'der',type:'spki'});
   if(pinnedSpki&&(pinnedSpki.length!==spki.length||!timingSafeEqual(pinnedSpki,spki))){req.destroy(new Error('guest key changed'));return;}
   const chunks=[];let size=0;
   res.on('data',b=>{size+=b.length;if(size>maxBytes)req.destroy(new Error('response too large'));else chunks.push(b);});
   res.on('error',reject);res.on('end',()=>{
    try{if(res.statusCode!==200)throw new Error(`HTTP ${res.statusCode}`);resolve({body:JSON.parse(Buffer.concat(chunks)),spki});}catch(e){reject(e);}
   });
  });
  const timer=setTimeout(()=>req.destroy(new Error('request deadline exceeded')),timeoutMs);
  req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end(bytes);
 });
}

/** Expectations MUST be independently derived from the current ledger/catalog,
 * pinned runtime release and authenticated current host session. No values
 * learned from the report are promoted to trusted expectations here.
 */
export function verifiedAppRequest({loadExpectations,collateral,now=Date.now}) {
 if(typeof loadExpectations!=='function')throw new Error('independent expectation loader required');
 return async(job,request)=>{
  const exp=await loadExpectations(job);
  if(exp.deploymentId!==job.deployment.id||exp.hostId!==job.offer.hostId
    || !/^[0-9a-f]{64}$/.test(exp.appId||''))throw new Error('wrong expected deployment, host or artifact');
  const origin=new URL(exp.origin);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
   throw new Error('invalid attested origin');
  const nonce=randomBytes(32),at=now();
  const capture=await exchange(new URL('/.well-known/enclave-attestation?nonce='+nonce.toString('hex'),origin),{timeoutMs:request.timeoutMs});
  let verdict;
  if(exp.kind==='shield') {
   if(!Number.isSafeInteger(exp.hostSessionAtMs)||exp.hostSessionAtMs>at||at-exp.hostSessionAtMs>30000)
    throw new Error('current authenticated host session required');
   verdict=verifyShieldAppPolicy({doc:capture.body,handshakeSpki:capture.spki,nonce,
    expectedAppSha256:exp.appId,expectedRuntimeId:exp.runtimeId,hostSession:exp.hostSession},exp.policy);
   if(!verdict.ok)throw new Error('Shield app evidence rejected: '+verdict.reason);
  } else if(exp.kind==='snp') {
   const rid=runtimeId(exp.runtimeIdentity);
   verdict=await verifyEvidence(capture.body,{policy:exp.policy,collateral,
    context:{transportKeySpki:capture.spki,nonce,expectedBinding:bind2(capture.spki,nonce,rid),
     expectedAppId:Buffer.from(exp.appId,'hex'),expectedHostData:Buffer.from(job.deployment.id.slice(2),'hex'),
     auxblob:capture.body.certs?Buffer.from(capture.body.certs,'base64'):undefined,now:new Date(at).toISOString()}});
   if(verdict.status!=='verified'||verdict.admissionSafe!==true)throw new Error('SNP app evidence rejected');
  } else throw new Error('unsupported isolation verifier');
  const target=new URL(request.path,origin);if(target.origin!==origin.origin)throw new Error('cross-origin workload');
  const remainingMs=request.timeoutMs-(now()-at);
  if(remainingMs<=0)throw new Error('request deadline exceeded');
  const response=await exchange(target,{...request,timeoutMs:remainingMs,pinnedSpki:capture.spki});
  return {body:response.body,attestationVerified:true,hostId:exp.hostId,deploymentId:exp.deploymentId,
   evidence:{nonce:nonce.toString('hex'),document:capture.body,spki:capture.spki.toString('base64'),verdict}};
 };
}
