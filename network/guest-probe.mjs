import https from 'node:https';
import {randomBytes,createHash} from 'node:crypto';
import {SocksHttpsAgent} from './socks-connect.mjs';
import {LocalAppHttpsAgent} from './local-app-transport.mjs';
import {judge} from '../isolation/m2/judge.mjs';
import {runtimeId} from '../isolation/contract/runtime.mjs';
import {verifyShieldAppPolicy} from '../relay/shield-app-policy.mjs';

function get(hostname,address,path,agent,pin){return new Promise((resolve,reject)=>{
 const req=https.get({host:address,port:443,servername:hostname,headers:{host:hostname},path,agent,timeout:15000},res=>{
  const spki=res.socket.getPeerX509Certificate()?.publicKey.export({format:'der',type:'spki'});
  if(!spki||(pin&&!pin.equals(spki))){res.destroy();reject(new Error('guest TLS key changed'));return;}
  const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>2097152)res.destroy(new Error('guest proof too large'));else chunks.push(b)});
  res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,spki,bytes:Buffer.concat(chunks)}));
 });req.once('timeout',()=>req.destroy(new Error('guest probe timeout')));req.once('error',reject);
});}
const GUEST_BUSY=/attestation busy; retry|too many concurrent report requests/,GUEST_BUSY_RETRIES=5;
export async function probeGuest({deploymentId,hostname,address,proxy,expected,linux,shield,hostSession,localUpstream,openApp,domainIndependent=false,verifySnp=judge}){
 if([proxy,localUpstream,openApp].filter(Boolean).length!==1)throw new Error('guest probes require exactly one guarded or local app transport');
 const agent=(localUpstream||openApp)?new LocalAppHttpsAgent(localUpstream,deploymentId,{openApp}):new SocksHttpsAgent(proxy,domainIndependent?{tlsOptions:{rejectUnauthorized:false,servername:''}}:{}),nonce=randomBytes(32);
 address=(localUpstream||openApp)?'127.0.0.1':address;
 try{
  // A Shield guest makes one TPM report at a time (~3 s) and answers any other
  // request meanwhile with HTTP 500 "busy; retry"; Nan and clients ask too, so
  // that answer is waited out rather than counted against the route.
  let response;
  for(let attempt=0;;attempt++){
    response=await get(hostname,address,'/.well-known/enclave-attestation?nonce='+nonce.toString('hex'),agent);
    if(response.status!==500||attempt>=GUEST_BUSY_RETRIES||!GUEST_BUSY.test(response.bytes.subarray(0,512).toString('utf8')))break;
    await new Promise(r=>setTimeout(r,1000+Math.floor(Math.random()*2500)));
  }
  if(response.status!==200)throw new Error('guest attestation HTTP '+response.status);
  const doc=JSON.parse(response.bytes);
  if(doc.nonce!==nonce.toString('hex')||doc.transportKey!==response.spki.toString('base64')||doc.appSha256!==expected.appSha256)throw new Error('app, nonce or TLS binding mismatch');
  let verified=false;
  if(doc.format==='sev-snp-guest-domain-v1'&&linux){
    if(runtimeId(linux.runtime).toString('hex')!==expected.runtimeId)throw new Error('SNP runtime policy does not match expected runtime');
    const verdict=await verifySnp(doc,response.spki,nonce,{...linux,appSha:expected.appSha256,hostData:deploymentId,mode:'trusted'});
    verified=verdict.gateOpen===true&&verdict.verdict==='attested';if(!verified)throw new Error('SNP guest proof refused: '+JSON.stringify(verdict));
  }else if(shield&&hostSession){
    const verdict=verifyShieldAppPolicy({doc,handshakeSpki:response.spki,nonce,expectedAppSha256:expected.appSha256,expectedRuntimeId:expected.runtimeId,hostSession},shield);
    verified=verdict.ok===true;if(!verified)throw new Error('Shield guest proof refused: '+verdict.reason);
  }else throw new Error('no independently trusted guest verification policy');
  const ready=await get(hostname,address,'/.well-known/enclave-ready',agent,response.spki);
  if(ready.status!==200)throw new Error('guest readiness HTTP '+ready.status);
  return {verified,deploymentId,appSha256:expected.appSha256,runtimeId:expected.runtimeId,spkiSha256:createHash('sha256').update(response.spki).digest('hex')};
 }finally{agent.destroy();}
}
