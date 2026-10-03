import https from 'node:https';
import {randomBytes,createHash} from 'node:crypto';
import {SocksHttpsAgent,DirectHttpsAgent} from './socks-connect.mjs';
import {LocalAppHttpsAgent} from './local-app-transport.mjs';
import {judge} from '../isolation/m2/judge.mjs';
import {runtimeId} from '../isolation/contract/runtime.mjs';
import {verifyShieldAppPolicy} from '../relay/shield-app-policy.mjs';

const observedPeerKeys=new WeakMap();
function get(hostname,address,path,agent,pin,port=443){return new Promise((resolve,reject)=>{
 const req=https.get({host:address,port,servername:hostname,headers:{host:hostname},path,agent,timeout:15000},res=>{
  const spki=observedPeerKeys.get(res.socket)||res.socket.getPeerX509Certificate()?.publicKey.export({format:'der',type:'spki'});
  if(!spki||(pin&&!pin.equals(spki))){res.destroy();reject(new Error('guest TLS key changed'));return;}
  const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>2097152)res.destroy(new Error('guest proof too large'));else chunks.push(b)});
  res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,spki,bytes:Buffer.concat(chunks)}));
 });req.once('timeout',()=>req.destroy(new Error('guest probe timeout')));req.once('error',reject);
});}
const GUEST_BUSY=/attestation busy; retry|too many concurrent report requests/,GUEST_BUSY_RETRIES=5;
export async function probeGuest({deploymentId,hostname,address,port=443,proxy,direct=false,expected,linux,shield,hostSession,localUpstream,openApp,domainIndependent=false,verifySnp=judge,pinnedSpkiSha256=null,startupEgress=false}){
 if(startupEgress&&(!openApp||proxy||pinnedSpkiSha256||expected.requiresConfigSocketServer!==true||expected.requiresSecretsV1!==true))throw new Error('startup egress requires a local configured secret command proof');
 if([proxy,localUpstream,openApp,direct].filter(Boolean).length!==1)throw new Error('guest probes require exactly one explicit app transport');
 if(direct&&(!pinnedSpkiSha256||domainIndependent))throw new Error('direct route probes require an attested key and SNI');
 // The locally attested key authenticates a route even before its WebPKI
 // certificate is installed. SNI remains present for shared public listeners;
 // only a dedicated native port uses domainIndependent transport.
 const routeTls={tlsOptions:{...(domainIndependent||pinnedSpkiSha256?{rejectUnauthorized:false}:{}),...(domainIndependent?{servername:''}:{})},
   ...(pinnedSpkiSha256?{verifyPeer:connection=>{
     const key=connection.getPeerX509Certificate()?.publicKey.export({format:'der',type:'spki'});
     if(!key||createHash('sha256').update(key).digest('hex')!==pinnedSpkiSha256)throw new Error('guest TLS key changed');
     observedPeerKeys.set(connection,key);
   }}:{})};
 const agent=(localUpstream||openApp)?new LocalAppHttpsAgent(localUpstream,deploymentId,{openApp,attestationOnly:startupEgress}):direct?new DirectHttpsAgent(routeTls):new SocksHttpsAgent(proxy,routeTls),nonce=randomBytes(32);
 address=(localUpstream||openApp)?'127.0.0.1':address;
 try{
  // A route probe for a guest whose current proof bound TLS key K needs no new
  // report: a TLS session that completes with K reaches that guest (only it
  // holds K's private key), and its readiness answer says it is serving. A
  // changed key is rejected; only a fresh local attestation may replace K.
  if(pinnedSpkiSha256){
    const ready=await get(hostname,address,'/.well-known/enclave-ready',agent,undefined,port);
    const spkiSha256=createHash('sha256').update(ready.spki).digest('hex');
    if(spkiSha256===pinnedSpkiSha256){
      if(ready.status!==200)throw new Error('guest readiness HTTP '+ready.status);
      return {verified:true,deploymentId,appSha256:expected.appSha256,runtimeId:expected.runtimeId,spkiSha256,pinned:true};
    }
    throw new Error('guest TLS key changed');
  }
  // A Shield guest makes one TPM report at a time (~3 s) and answers any other
  // request meanwhile with HTTP 500 "busy; retry"; Nan and clients ask too, so
  // that answer is waited out rather than counted against the route.
  let response;
  for(let attempt=0;;attempt++){
    response=await get(hostname,address,'/.well-known/enclave-attestation?nonce='+nonce.toString('hex'),agent,undefined,port);
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
    const verdict=verifyShieldAppPolicy({doc,handshakeSpki:response.spki,nonce,expectedAppSha256:expected.appSha256,expectedRuntimeId:expected.runtimeId,hostSession,requiresConfigBundleV5:expected.requiresConfigBundleV5,requiresSecretsV1:expected.requiresSecretsV1,requiresConfigSocketServer:expected.requiresConfigSocketServer},shield);
    verified=verdict.ok===true;if(!verified)throw new Error('Shield guest proof refused: '+verdict.reason);
  }else throw new Error('no independently trusted guest verification policy');
  const ready=await get(hostname,address,'/.well-known/enclave-ready',agent,response.spki,port);
  if(ready.status!==200&&!(startupEgress&&ready.status===503))throw new Error('guest readiness HTTP '+ready.status);
  return {ready:ready.status===200,verified,deploymentId,appSha256:expected.appSha256,runtimeId:expected.runtimeId,spkiSha256:createHash('sha256').update(response.spki).digest('hex')};
 }finally{agent.destroy();}
}
