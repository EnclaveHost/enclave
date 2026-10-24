// Candidate integration: fresh public recipient evidence. No signing, VM actions, or application secrets sent.
// The discovery connection is trusted only after its actual TLS key is bound by the independently verified SNP quote.
import https from 'node:https';import {randomBytes} from 'node:crypto';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {canonical,sha256hex} from './canonical.mjs';
const need=(ok,m)=>{if(!ok)throw Error('recipient attestation refused: '+m);};
const hash=x=>sha256hex(canonical(x)),H=/^[a-f0-9]{64}$/,ID=/^0x[a-f0-9]{64}$/;
export const RECIPIENT_VERIFIER_FILES=Object.freeze({
 'isolation/m2/judge.mjs':'650b931d32ef72c84459141f6deeaf0f5a7a4e8c6441ac95f47f4bd8a624f1dd',
 'isolation/contract/runtime.mjs':'8bb7f911c32bd992db83e1884db3c6059044338aa06ee64f9207adda25fd4b69',
 'relay/snp-verify.mjs':'10520dd25d6a7a40225a7076521c383fc3eb296b1f290ac6b9e9fbbd1697de91'
});
export const RECIPIENT_QUOTE_MAX_MS=120000;
function b64(s,max){need(typeof s==='string'&&s.length<=Math.ceil(max/3)*4&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s),'malformed evidence encoding');const b=Buffer.from(s,'base64');need(b.length<=max&&b.toString('base64')===s,'noncanonical evidence encoding');return b;}
export function fetchRecipientEvidence({id,nonce,requestImpl=https.request}){
 need(ID.test(id)&&Buffer.isBuffer(nonce)&&nonce.length===32,'exact deployment and nonce required');
 const hostname=id.slice(2,10)+'.app.enclave.host';
 return new Promise((resolve,reject)=>{
  let req,done=false,spki=null,size=0;const chunks=[];
  const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);if(err){req?.destroy();reject(Error('recipient evidence transport unavailable or invalid'));}else resolve(value);};
  const timer=setTimeout(()=>finish(true),20000);
  try{
   // Public attestation GET only. No TLS session reuse, redirect, cookie, key or canary value is sent.
   req=requestImpl({hostname,port:443,servername:hostname,path:'/.well-known/enclave-attestation?nonce='+nonce.toString('hex'),method:'GET',agent:false,rejectUnauthorized:false,minVersion:'TLSv1.3',headers:{'Cache-Control':'no-store'}},res=>{
    if(res.statusCode!==200||!spki||!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type']||''))return finish(true);
    const length=res.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>262144))return finish(true);
    res.on('data',b=>{size+=b.length;if(size>262144)return finish(true);chunks.push(Buffer.from(b));});res.on('error',()=>finish(true));res.on('aborted',()=>finish(true));
    res.on('end',()=>{if(done)return;try{const raw=Buffer.concat(chunks);finish(null,{doc:JSON.parse(raw.toString('utf8')),spki,documentSha256:sha256hex(raw)});}catch{finish(true);}});
   });
   req.on('socket',socket=>socket.once('secureConnect',()=>{try{need(!socket.isSessionReused(),'resumed TLS connection');const cert=socket.getPeerX509Certificate();spki=cert?.publicKey.export({type:'spki',format:'der'});need(Buffer.isBuffer(spki)&&spki.length<=4096,'peer TLS key absent');}catch{finish(true);}}));
   req.on('error',()=>finish(true));req.end();
  }catch{finish(true);}
 });
}
export async function attestRecipient({id,pins,recipient,judge,runtimeId,parseSnpReport,fetchEvidence=fetchRecipientEvidence,rng=randomBytes,now=()=>Date.now()}){
 try{
  const i=pins.image;need(ID.test(id)&&!/^0x0{64}$/.test(id)&&recipient?.status==='recipient-observed'&&recipient.identity?.id===id&&recipient.instance?.name===id,'live recipient observation required');
  need(H.test(i?.appId)&&H.test(i.runtimeId)&&/^[a-f0-9]{96}$/.test(i.measurement)&&['appId','runtimeId','measurement'].every(k=>recipient.identity[k]===i[k]&&recipient.instance[k]===i[k]),'recipient image pins differ');
  need(H.test(recipient.instance.transportKeySha256),'observed transport key missing');
  const floors={Genoa:{bootloader:10,tee:0,snp:23,microcode:84},Turin:{fmc:1,bootloader:3,tee:2,snp:5,microcode:117}};
  need(Object.entries(floors).every(([product,min])=>Object.entries(min).every(([k,v])=>Number.isSafeInteger(i.minTcb?.[product]?.[k])&&i.minTcb[product][k]>=v)),'reviewed firmware floors required');
  const nonce=rng(32);need(Buffer.isBuffer(nonce)&&nonce.length===32,'fresh nonce required');const requestedAt=now();need(Number.isSafeInteger(requestedAt),'local clock invalid');
  const e=await fetchEvidence({id,nonce}),d=e?.doc;need(Buffer.isBuffer(e?.spki)&&e.spki.length>0&&e.spki.length<=4096&&sha256hex(e.spki)===recipient.instance.transportKeySha256,'public TLS key differs from observed recipient');
  need(d?.format==='sev-snp-guest-domain-v1'&&d.abi==='enclave-domain-abi/2'&&d.nonce===nonce.toString('hex'),'unexpected recipient format, ABI or nonce');
  need(b64(d.transportKey,4096).equals(e.spki),'document key differs from TLS handshake');
  need(runtimeId(d.runtime).toString('hex')===i.runtimeId,'quoted runtime differs from pinned runtime');
  const report=b64(d.report,1184);need(report.length===1184,'SNP report size differs');if(d.certs)b64(d.certs,131072);
  const parsed=parseSnpReport(report);need(parsed.vmpl===0&&(parsed.policy&((1n<<18n)|(1n<<19n)))===0n,'recipient privilege or unsafe guest policy');
  const v=await judge(d,e.spki,nonce,{measurement:i.measurement,appSha:i.appId,mode:'trusted',minTcb:structuredClone(i.minTcb),expectedVmpl:0,runtime:d.runtime,hostData:id,kds:false,...(i.releases?{release:i.releases}:{})});
  need(v?.verdict==='attested'&&v.gateOpen===true&&v.vmpl===0&&v.tcb?.checked===true&&v.measurement===i.measurement&&v.hostData===id.slice(2)&&runtimeId(v.runtime).toString('hex')===i.runtimeId,'AMD-rooted recipient verification failed');
  const verifiedAt=now();need(Number.isSafeInteger(verifiedAt)&&verifiedAt>=requestedAt&&verifiedAt-requestedAt<=RECIPIENT_QUOTE_MAX_MS,'recipient quote expired');
  return {status:'recipient-attested',id,instanceId:recipient.instance.id,attemptDigest:recipient.attemptDigest,measurement:i.measurement,appId:i.appId,runtimeId:i.runtimeId,transportKeySha256:sha256hex(e.spki),challengeSha256:sha256hex(nonce),quoteSha256:sha256hex(report),requestedAt,verifiedAt,expectedVmpl:0,minimumTcbChecked:true,amdVerified:true,kdsFallback:false,
   scope:'Fresh public TLS-key-bound recipient SNP quote matched to the observed canary. Does not prove secret consumption, relay plaintext exclusion, rollback protection or decentralized custody.'};
 }catch{throw Error('recipient attestation refused: fresh pinned hardware evidence unavailable or inconsistent');}
}
export async function verifyLiveRecipient({id,pins,observeRecipient,attest,now=()=>Date.now()}){
 const started=now(),before=await observeRecipient(),quote=await attest({id,pins,recipient:before});
 need(quote?.status==='recipient-attested'&&quote.id===id&&quote.attemptDigest===before.attemptDigest&&quote.transportKeySha256===before.instance.transportKeySha256
  &&Number.isSafeInteger(quote.requestedAt)&&Number.isSafeInteger(quote.verifiedAt)&&quote.requestedAt>=started&&quote.verifiedAt>=quote.requestedAt&&quote.verifiedAt<=now(),'fresh recipient attestation required');
 const after=await observeRecipient();need(after.status==='recipient-observed'&&['attemptDigest','custodianWindowDigest','identity','instance','process'].every(k=>hash(before[k])===hash(after[k])),'recipient changed during attestation');
 need(now()>=started&&now()-started<=RECIPIENT_QUOTE_MAX_MS,'recipient verification expired');return {status:'recipient-verified',observation:after,attestation:quote};
}
export async function loadRecipientAttestor(pins){
 for(const [rel,want]of Object.entries(RECIPIENT_VERIFIER_FILES))need(pins.repo.files?.[rel]===want&&sha256hex(fs.readFileSync(path.join(pins.repo.path,rel)))===want,'reviewed verifier source missing');
 const {judge}=await import(pathToFileURL(path.join(pins.repo.path,'isolation/m2/judge.mjs')).href),{runtimeId}=await import(pathToFileURL(path.join(pins.repo.path,'isolation/contract/runtime.mjs')).href),{parseSnpReport}=await import(pathToFileURL(path.join(pins.repo.path,'relay/snp-verify.mjs')).href);
 return args=>attestRecipient({...args,pins,judge,runtimeId,parseSnpReport});
}
