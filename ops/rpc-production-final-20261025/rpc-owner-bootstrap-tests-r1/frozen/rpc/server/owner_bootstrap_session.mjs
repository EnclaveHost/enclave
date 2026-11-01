// One original storage-owner attempt. No registry, central verifier, writable
// grant or recovery/reset API. The owner process must already be independently
// bounded; its caller supplies the validated ORIGINAL local startup clock.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,X509Certificate} from 'node:crypto';
import {ekPublicFrom,makeCredential} from '../../relay/vbs-credential.mjs';
import {tpmNameOf,loadTpmRoots,verifyEkChain,VBS_MAX_CERT_BYTES,VBS_MAX_CHAIN_CERTS,VBS_MAX_TPMT_PUBLIC_BYTES} from '../../relay/vbs-verify.mjs';
import {tpmManufacturerOf,TPM_MANUFACTURERS_ON_DIE} from '../../relay/vbs-tpm.mjs';
import {rpcStorageRequestBytes,sha256} from '../../isolation/contract/rpc-bootstrap.mjs';
import {verifyRPCBootstrap} from './verify_bootstrap.mjs';

const C=fs.constants;
const exact=(v,keys)=>v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
export function base64(v,max){
 if(typeof v!=='string'||!v.length||v.length>4*Math.ceil(max/3))throw Error('bounded base64 required');
 const b=Buffer.from(v,'base64');if(b.length>max||b.toString('base64')!==v)throw Error('canonical base64 required');return b;
}
export function canonicalWire(raw,max){
 if(!Buffer.isBuffer(raw)||!raw.length||raw.length>max)throw Error('wire bound');
 const value=JSON.parse(raw.toString('utf8'));
 if(!Buffer.from(JSON.stringify(value)).equals(raw))throw Error('complete duplicate-free JSON required');
 return value;
}
export function privateDirectory(name){
 if(!path.isAbsolute(name)||fs.realpathSync(name)!==name)throw Error('canonical owner directory required');
 for(let p=name;;p=path.dirname(p)){
  const s=fs.lstatSync(p);if(!s.isDirectory()||![0,process.geteuid()].includes(s.uid)||(s.mode&0o022))throw Error('protected owner ancestors required');
  if(p==='/')break;
 }
 const fd=fs.openSync(name,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW|C.O_CLOEXEC),s=fs.fstatSync(fd);
 if(s.uid!==process.geteuid()||(s.mode&0o7777)!==0o700){fs.closeSync(fd);throw Error('private owner directory required');}
 return fd;
}
export function persist(fd,name,raw){
 if(!/^[a-z][a-z0-9.-]+$/.test(name)||!Buffer.isBuffer(raw)||!raw.length||raw.length>12<<20)throw Error('bounded fixed owner record required');
 const file=fs.openSync(`/proc/self/fd/${fd}/${name}`,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW|C.O_CLOEXEC,0o600);
 try{fs.writeFileSync(file,raw);fs.fsyncSync(file);}finally{fs.closeSync(file);}
 fs.fsyncSync(fd);
}
const encode=v=>Buffer.from(JSON.stringify(v)+'\n');

export function createOwnerBootstrap({parent,original,request,runtime,clientCertificate,keys,policy}){
 if(!exact(original,['attempt','boot','originMonotonicNs','deadlineMonotonicNs'])||!/^[0-9a-f]{32}$/.test(original.attempt)||!Number.isSafeInteger(original.originMonotonicNs)||original.originMonotonicNs<0||!Number.isSafeInteger(original.deadlineMonotonicNs)||original.deadlineMonotonicNs-original.originMonotonicNs!==900000000000)throw Error('validated original owner clock required');
 const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
 if(boot!==original.boot)throw Error('original owner boot differs');
 // Never compare the guest's monotonic values to the owner's clock domain.
 const current=()=>{const n=process.hrtime.bigint();if(n<BigInt(original.originMonotonicNs)||n>=BigInt(original.deadlineMonotonicNs))throw Error('original owner deadline ended');};
 current();
 const requestBytes=rpcStorageRequestBytes(request),digest=sha256(requestBytes).toString('hex');
 request=JSON.parse(requestBytes);policy=structuredClone(policy);
 if(!/^[0-9a-f]{64}$/.test(runtime)||runtime==='0'.repeat(64)||policy.schema!=='enclave-rpc-bootstrap-policy/1')throw Error('explicit owner runtime/policy required');
 const cert=base64(clientCertificate,16384),client=new X509Certificate(cert);
 if(client.ca||!client.raw.equals(cert)||client.publicKey.asymmetricKeyType!=='ed25519'||!client.verify(client.publicKey))throw Error('guest self-signed Ed25519 leaf required');
 if(!exact(keys,['ek','ekChain','aikPub','aikName','transportKey']))throw Error('exact host enrollment keys required');
 const ek=base64(keys.ek,VBS_MAX_CERT_BYTES),aik=base64(keys.aikPub,VBS_MAX_TPMT_PUBLIC_BYTES),name=base64(keys.aikName,34),spki=base64(keys.transportKey,64);
 if(!tpmNameOf(aik).equals(name)||spki.length!==44||spki.subarray(0,12).toString('hex')!=='302a300506032b6570032100')throw Error('host quoting/transport key differs');
 if(!Array.isArray(keys.ekChain)||keys.ekChain.length>VBS_MAX_CHAIN_CERTS)throw Error('bounded EK chain required');
 const leaf=new X509Certificate(ek),chain=keys.ekChain.map(x=>new X509Certificate(base64(x,VBS_MAX_CERT_BYTES))),trust=loadTpmRoots(policy.ekRoots);
 const verified=verifyEkChain(leaf,chain,trust,Date.now()),mfr=tpmManufacturerOf(ek);
 if(!verified.ok||leaf.ca||!TPM_MANUFACTURERS_ON_DIE[mfr])throw Error('owner-pinned on-die TPM EK required');
 const pfd=privateDirectory(parent);let fd;
 try{
  // Fixed name consumes the entire session before a nonce/credential exists.
  fs.mkdirSync(`/proc/self/fd/${pfd}/bootstrap`,{mode:0o700});fs.fsyncSync(pfd);
  fd=fs.openSync(`/proc/self/fd/${pfd}/bootstrap`,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW|C.O_CLOEXEC);
 }finally{fs.closeSync(pfd);}
 let consumed=false,closed=false;
 const credential=randomBytes(32),hostNonce=randomBytes(32),challenge=randomBytes(32);
 const close=()=>{closed=true;credential.fill(0);};
 try {
 const made=makeCredential(ekPublicFrom(ek),name,credential);
 const issued=process.hrtime.bigint(),cutoff=issued+30_000_000_000n<BigInt(original.deadlineMonotonicNs)?issued+30_000_000_000n:BigInt(original.deadlineMonotonicNs);
 const pub={schema:'enclave-rpc-owner-bootstrap-challenge/1',attempt:original.attempt,requestSha256:digest,challenge:challenge.toString('hex'),hostNonce:hostNonce.toString('base64'),credentialBlob:made.credentialBlob.toString('base64'),secret:made.secret.toString('base64'),rootsGranted:false,rpcReady:false};
 persist(fd,'challenge.intent',encode({original,requestSha256:digest,runtime,clientCertificateSha256:sha256(cert).toString('hex'),hostKeySha256:sha256(spki).toString('hex'),ekSha256:sha256(ek).toString('hex'),challengeSha256:sha256(challenge).toString('hex'),issuedMonotonicNs:issued.toString(),cutoffMonotonicNs:cutoff.toString(),rootsGranted:false,rpcReady:false}));
 return {
  challenge:()=>{current();if(closed||consumed||process.hrtime.bigint()>=cutoff)throw Error('bootstrap challenge unavailable');return structuredClone(pub);},
  directory:fd, clientCertificate:Buffer.from(cert), original:{...original},
  close,
  accept(raw,actualTLSCertificate){
   current();if(closed||consumed)throw Error('owner challenge consumed');consumed=true;
   try{
    persist(fd,'verify.intent',encode({requestSha256:digest,wireSha256:sha256(raw).toString('hex'),rootsGranted:false,rpcReady:false}));
    if(process.hrtime.bigint()>=cutoff)throw Error('owner challenge expired');
    const msg=canonicalWire(raw,12<<20);
    if(!exact(msg,['schema','evidence','hostEvidence'])||msg.schema!=='enclave-rpc-owner-bootstrap-evidence/1')throw Error('exact bootstrap wire required');
    const hostSession={evidence:msg.hostEvidence,nonce:hostNonce,transportKeySpki:spki,expectedCredential:credential,mintedFor:{ekCert:ek,aikName:name}};
    const verdict=verifyRPCBootstrap({evidence:msg.evidence,expectedRequest:request,expectedRuntimeId:runtime,challenge,handshakeCertificate:actualTLSCertificate,hostSession},policy);
    if(!verdict.ok)throw Error('owner bootstrap evidence refused: '+verdict.reason);
    current();if(process.hrtime.bigint()>=cutoff)throw Error('owner evidence completed late');
    const accepted={schema:'enclave-rpc-owner-bootstrap-accepted/1',requestSha256:digest,certificateSha256:sha256(cert).toString('hex'),rootsGranted:false,rpcReady:false};
    // Complete accepted evidence persisted BEFORE any acknowledgement/dispatch.
    persist(fd,'accepted-evidence.json',raw);persist(fd,'accepted.json',encode(accepted));return accepted;
   }finally{close();}
  }
 };
 } catch(e) {close();throw e;}
}
