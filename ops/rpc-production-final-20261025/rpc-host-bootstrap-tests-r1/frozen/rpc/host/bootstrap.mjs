// Host-side sequencing only. The caller supplies already-held monitor and TPM
// streams, an exclusive protected journal FD, existing host key and ORIGINAL
// host clock. No launcher, registry, key creation, VM operation or retry here.
// Timers close transport; they do not prove native death. The caller must be
// inside the independently supervised original-attempt envelope before entry.
import fs from 'node:fs';
import {createPublicKey,verify,X509Certificate} from 'node:crypto';
import {rpcStorageRequestBytes,sha256,RPC_BOOTSTRAP_PURPOSE} from '../../isolation/contract/rpc-bootstrap.mjs';
import {runtimeId} from '../../isolation/contract/runtime.mjs';
import {tpmNameOf} from '../../relay/vbs-verify.mjs';
import {buildHvNodeFrame} from '../../windows/node/hvnode-evidence.mjs';
import {offerBytes} from '../server/owner_bootstrap_offer.mjs';

const used=new WeakSet(),hex=/^[0-9a-f]{64}$/;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const encode=v=>Buffer.from(JSON.stringify(v));
const b64=(s,max)=>{if(typeof s!=='string'||s.length>4*Math.ceil(max/3))throw Error('base64 bound');const b=Buffer.from(s,'base64');if(!b.length||b.length>max||b.toString('base64')!==s)throw Error('canonical base64 required');return b;};
const unhex=(s,max)=>{if(typeof s!=='string'||s.length>max*2||!s.length||s.length%2||!/^[0-9a-f]+$/.test(s))throw Error('canonical TPM bytes required');return Buffer.from(s,'hex');};

// One private stream per role. A timeout or malformed reply poisons the whole
// attempt rather than allowing the late reply to satisfy a following command.
function lines(stream,maximum,alive){
 if(!stream||typeof stream.write!=='function'||typeof stream.destroy!=='function'||used.has(stream))throw Error('unshared held stream required');
 used.add(stream);
 let data=Buffer.alloc(0),failure=null,wake;
 const fail=e=>{failure=e;stream.destroy();wake?.();};
 stream.on('data',b=>{if(data.length+b.length>maximum)fail(Error('stream reply bound'));else data=Buffer.concat([data,b]);wake?.();});
 stream.on('error',e=>{failure=e;wake?.();});stream.on('close',()=>{failure??=Error('held stream lost');wake?.();});stream.on('end',()=>{failure??=Error('held stream ended');wake?.();});
 return {close:()=>fail(Error('attempt closed')),async line(){
  for(;;){alive();if(failure)throw failure;const n=data.indexOf(10);if(n>=0){const raw=data.subarray(0,n);data=data.subarray(n+1);return raw;}await new Promise(r=>{wake=r;});wake=null;}
 },write(raw){alive();if(failure)throw failure;return new Promise((resolve,reject)=>stream.write(raw,e=>e?reject(e):resolve()));}};
}
function readLog(name){
 if(typeof name!=='string'||name.length>1024||name.includes('\0'))throw Error('bounded TPM log path required');
 const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size<1||st.size>8<<20)throw Error('TPM log bound');const raw=Buffer.alloc(st.size+1);let n=0;for(;;){const got=fs.readSync(fd,raw,n,raw.length-n,n);if(!got)break;n+=got;if(n===raw.length)break;}if(n!==st.size)throw Error('TPM log changed');return raw.subarray(0,n);}finally{fs.closeSync(fd);}
}

export function createRPCBootstrapHost({monitor,tpm,nodeKey,journalFd,expected,original,now,signal,ekChain=[]}){
 if(!exact(original,['originMonotonicNs','deadlineMonotonicNs'])||typeof original.originMonotonicNs!=='bigint'||original.originMonotonicNs<0n||original.deadlineMonotonicNs-original.originMonotonicNs!==900000000000n||typeof now!=='function'||!signal||typeof signal.addEventListener!=='function')throw Error('original supervised host clock and loss signal required');
 const origin=original.originMonotonicNs,deadline=original.deadlineMonotonicNs;
 if(!exact(expected,['appId','deployment','profile','l1Volume','baseVolume','runtime','manifestSha256','ownerAttempt','ownerKeys'])||!Array.isArray(expected.ownerKeys)||expected.ownerKeys.length!==2||expected.ownerKeys.some(k=>!hex.test(k)||/^0+$/.test(k))||!hex.test(expected.runtime)||!hex.test(expected.manifestSha256)||!/^[0-9a-f]{32}$/.test(expected.ownerAttempt))throw Error('original deployment and both owner pins required');
 expected=structuredClone(expected);ekChain=ekChain.map(x=>b64(x,8192).toString('base64'));if(ekChain.length>8)throw Error('EK chain bound');
 const spki=createPublicKey(nodeKey.privateKey).export({type:'spki',format:'der'});
 if(nodeKey.privateKey.asymmetricKeyType!=='ed25519'||!spki.equals(nodeKey.spki))throw Error('existing held host key differs');
 const stat=fs.fstatSync(journalFd);if(!stat.isFile()||stat.size!==0||stat.nlink!==1)throw Error('exclusive unused host journal required');
 let offset=0,closed=false,phase='new',info,keys,m,t,timer;
 function record(event,value={}){if(fs.fstatSync(journalFd).size!==offset)throw Error('host journal changed');const raw=Buffer.concat([encode({event,...value,rootsGranted:false,rpcReady:false}),Buffer.from('\n')]);let n=0;while(n<raw.length)n+=fs.writeSync(journalFd,raw,n,raw.length-n,offset+n);offset+=n;fs.fsyncSync(journalFd);}
 function alive(){const n=now();if(closed||signal.aborted||typeof n!=='bigint'||n<origin||n>=deadline)throw Error('original host attempt lost or expired');}
 function close(){if(closed)return;closed=true;clearTimeout(timer);signal.removeEventListener('abort',close);m?.close();t?.close();}
 alive();record('host-bootstrap-intent',{ownerAttempt:expected.ownerAttempt});
 try{m=lines(monitor,65536,alive);t=lines(tpm,65536,alive);}catch(e){close();throw e;}
 signal.addEventListener('abort',close,{once:true});
 timer=setTimeout(close,Math.max(1,Number((deadline-now())/1000000n)));
 async function step(fn){alive();let timeout;try{return await Promise.race([Promise.resolve().then(fn).then(x=>{alive();return x;}),new Promise((_,reject)=>{timeout=setTimeout(()=>{close();reject(Error('bounded host exchange expired'));},Math.max(1,Math.min(3000,Number((deadline-now())/1000000n))));})]);}finally{clearTimeout(timeout);}}
 async function command(req,body=Buffer.alloc(0)){return step(async()=>{await m.write(Buffer.concat([encode(req),Buffer.from('\n'),body]));const raw=await m.line();const v=JSON.parse(raw);if(!encode(v).equals(raw))throw Error('exact monitor reply required');if(v.error)throw Error('guest refused bootstrap');return v;});}
 async function tpmCommand(cmd){return step(async()=>{await t.write(Buffer.from(cmd+'\n'));const out={};let bytes=0;for(;;){let raw=await t.line();if(raw.at(-1)===13)raw=raw.subarray(0,-1);bytes+=raw.length;if(bytes>65536)throw Error('TPM response bound');const line=raw.toString('utf8');if(line==='ok')return out;if(line.startsWith('err '))throw Error('TPM command refused');const n=line.indexOf(' ');if(n<1||Object.hasOwn(out,line.slice(0,n)))throw Error('TPM reply shape');out[line.slice(0,n)]=line.slice(n+1);}});}
 const context=()=>({boot:info.request.boot,requestSha256:info.requestSha256});
 function publicInfo(p){
  if(!exact(p,['purpose','request','requestSha256','runtime','transportKey','certificate','rootsGranted','rpcReady'])||p.purpose!==RPC_BOOTSTRAP_PURPOSE||p.rootsGranted!==false||p.rpcReady!==false)throw Error('bootstrap public identity required');
  for(const k of ['appId','deployment','profile','l1Volume','baseVolume'])if(p.request[k]!==expected[k])throw Error('guest deployment differs');
  if(sha256(rpcStorageRequestBytes(p.request)).toString('hex')!==p.requestSha256||runtimeId(p.runtime).toString('hex')!==expected.runtime)throw Error('guest request/runtime differs');
  const cert=new X509Certificate(b64(p.certificate,16384));if(cert.ca||!cert.verify(cert.publicKey)||!cert.publicKey.export({type:'spki',format:'der'}).equals(b64(p.transportKey,4096)))throw Error('guest public credential differs');
 }
 return {close,
  async enroll(){if(phase!=='new')throw Error('enrollment consumed');phase='enrolling';try{
   record('enrollment-intent');info=await command({cmd:'rpc-bootstrap-info'});publicInfo(info);
   const ready=await step(()=>t.line());if(!/^ready [^\r\n]{1,512}\r?$/.test(ready.toString()))throw Error('held TPM startup receipt required');
   const k=await tpmCommand('keys'),aik=unhex(k['aik-pub'],4096),name=tpmNameOf(aik);
   if(!name.equals(unhex(k['aik-name'],34)))throw Error('TPM name differs');
   keys={ek:unhex(k['ek-cert'],8192).toString('base64'),ekChain:[...ekChain],aikPub:aik.toString('base64'),aikName:name.toString('base64'),transportKey:spki.toString('base64')};
   record('enrollment-complete',{requestSha256:info.requestSha256,ekSha256:sha256(Buffer.from(keys.ek,'base64')).toString('hex')});phase='enrolled';return {info:structuredClone(info),keys:structuredClone(keys)};
  }catch(e){close();throw e;}},
  async finish({proof,ownerServerDer,exportServerDer,policy}){if(phase!=='enrolled')throw Error('owner offer gate consumed');phase='consumed';try{
   record('owner-offer-intent');if(!exact(proof,['base','l1','offer']))throw Error('complete owner offer required');const o=proof.offer,raw=offerBytes(o);
   for(const [role,sig] of [proof.l1,proof.base].entries()){
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(expected.ownerKeys[role],'hex')]),format:'der',type:'spki'});
    if(typeof sig!=='string'||!/^[0-9a-f]{128}$/.test(sig)||!verify(null,Buffer.concat([Buffer.from('ENCLAVE-RPC-OWNER-ENDPOINT/1\0'),Buffer.from([role]),sha256(raw)]),key,Buffer.from(sig,'hex')))throw Error('original owner endpoint signature refused');
   }
   if(o.attempt!==expected.ownerAttempt||o.requestSha256!==info.requestSha256||o.runtime!==expected.runtime||o.manifestSha256!==expected.manifestSha256||o.clientCertificateSha256!==sha256(b64(info.certificate,16384)).toString('hex')||o.serverCertificateSha256!==sha256(b64(ownerServerDer,16384)).toString('hex'))throw Error('owner offer differs from enrollment');
   b64(exportServerDer,16384);b64(policy,65536);
   const frame=await buildHvNodeFrame({nonce:b64(o.hostNonce,32),credentialBlob:b64(o.credentialBlob,4096),secret:b64(o.secret,4096),spki,privateKey:nodeKey.privateKey,tpm:tpmCommand,readLog});
   const hostEvidence=JSON.parse(b64(frame.rad.body,11<<20));
   if(hostEvidence.ek.cert!==keys.ek||hostEvidence.quote.aikPub!==keys.aikPub)throw Error('TPM enrollment changed');hostEvidence.ek.chain=[...keys.ekChain];
   const report=await command({cmd:'rpc-bootstrap-attest',...context(),challenge:o.challenge});
   if(!exact(report,[...Object.keys(info),'challenge','vbsVmReport'])||report.challenge!==o.challenge||Object.keys(info).some(k=>JSON.stringify(report[k])!==JSON.stringify(info[k])))throw Error('guest report identity changed');b64(report.vbsVmReport,9000);
   // Report itself stays monitor-owned. Never send it back as a host assertion.
   const body=encode({exportServerDer,hostEvidence,offer:proof,ownerServerDer,policy});if(body.length>12<<20)throw Error('owner input bound');
   record('owner-input-submit',{sha256:sha256(body).toString('hex')});
   const installed=await command({cmd:'rpc-bootstrap-owner',...context(),size:body.length},body);
   if(!exact(installed,['ownerInputsPrepared','rootsGranted','rpcReady'])||installed.ownerInputsPrepared!==true||installed.rootsGranted!==false||installed.rpcReady!==false)throw Error('owner input receipt differs');
   record('acquire-submit');const result=await command({cmd:'rpc-bootstrap-acquire',...context()});
   if(!exact(result,['acquisitionRequested','rootsGranted','rpcReady'])||result.acquisitionRequested!==true||result.rootsGranted!==false||result.rpcReady!==false)throw Error('acquisition receipt differs');
   record('acquisition-requested');return result;
  }catch(e){close();throw e;}finally{close();}}
 };
}
