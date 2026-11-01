// Real streams and durable files; TPM hardware and guest monitor are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {randomBytes,generateKeyPairSync,X509Certificate,sign,constants} from 'node:crypto';
import {makeVbsWorld,tmpdir,buildLog,buildQuote} from '../fixtures/vbs-synthetic.mjs';
import {activateCredential} from '../../relay/vbs-credential.mjs';
import {runtimeId} from '../../isolation/contract/runtime.mjs';
import {rpcBootstrapBinding,sha256} from '../../isolation/contract/rpc-bootstrap.mjs';
import {createOwnerBootstrap} from '../../rpc/server/owner_bootstrap_session.mjs';
import {signOwnerOffer} from '../../rpc/server/owner_bootstrap_offer.mjs';
import {createRPCBootstrapHost} from '../../rpc/host/bootstrap.mjs';
process.umask(0o077);
fs.mkdirSync('/run/host-flow',{mode:0o700});
const vector=JSON.parse(fs.readFileSync(process.env.RPC_BOOTSTRAP_VECTOR_DIR+'/bootstrap-vector.json'));
const world=makeVbsWorld(tmpdir('rpc-host-tpm-')),L=buildLog({idksPub:world.idks.publicKey});
const log='/run/host-flow/boot.log';fs.writeFileSync(log,L.log);
execFileSync('/usr/bin/openssl',['req','-x509','-newkey','ed25519','-nodes','-keyout','/run/host-flow/key','-out','/run/host-flow/cert','-days','1','-subj','/CN=localhost','-addext','basicConstraints=critical,CA:FALSE','-addext','extendedKeyUsage=clientAuth'],{stdio:'pipe',timeout:3000});
const cert=new X509Certificate(fs.readFileSync('/run/host-flow/cert')),b64=b=>b.toString('base64');
const info={...vector.evidence,certificate:b64(cert.raw),transportKey:b64(cert.publicKey.export({type:'spki',format:'der'}))};delete info.challenge;delete info.vbsVmReport;
const image='ab'.repeat(32),identity={signer:'91'.repeat(32),productId:1818455653,moduleId:1734437220},rid=runtimeId(info.runtime).toString('hex');
const policy={schema:'enclave-rpc-bootstrap-policy/1',ekRoots:world.ca.bundlePem,platforms:'attested',minimumGuestSvn:5,images:[{rpcBootstrap:true,measurement:image,runtimeId:rid,profileSha256:info.request.profile,identity}]};
const ownerKeys=[generateKeyPairSync('ed25519'),generateKeyPairSync('ed25519')],pubs=ownerKeys.map(k=>k.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex'));
const seed=()=>ownerKeys.map(k=>Buffer.from(k.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32)));
function report(challenge){
 const e={...structuredClone(info),challenge},binding=rpcBootstrapBinding({request:e.request,spki:Buffer.from(e.transportKey,'base64'),certificate:cert.raw,challenge:Buffer.from(challenge,'hex'),runtime:Buffer.from(rid,'hex')});
 const claims=Buffer.from(JSON.stringify({'user-data':binding.toString('hex')+e.request.appId})),env=Buffer.alloc(1236+claims.length),w=(o,n)=>env.writeUInt32LE(n,o);
 w(0,0x414c4348);w(4,2);w(8,env.length);w(12,2);w(1216,20+claims.length);w(1220,1);w(1224,1);w(1228,1);w(1232,claims.length);claims.copy(env,1236);
 const r=env.subarray(32,592);[560,1,1,256,0,2].forEach((n,i)=>r.writeUInt32LE(n,i*4));sha256(claims).copy(r,24);Buffer.from(image,'hex').copy(r,120);Buffer.from(identity.signer,'hex').copy(r,152);r.writeUInt32LE(5,216);r.writeUInt32LE(2,224);r.writeUInt32LE(5,228);r.writeUInt32LE(identity.productId,232);r.writeUInt32LE(identity.moduleId,236);sign('sha256',r.subarray(0,304),{key:world.idks.privateKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).copy(r,304);e.vbsVmReport=b64(env);return e;
}
async function pair(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const accept=once(server,'connection'),client=net.connect(server.address().port,'127.0.0.1');client.on('error',()=>{});await once(client,'connect');const [peer]=await accept;peer.on('error',()=>{});server.close();return {client,peer};}
function peerFrames(socket,handle){let data=Buffer.alloc(0),req=null;socket.on('data',b=>{data=Buffer.concat([data,b]);for(;;){if(!req){const nl=data.indexOf(10);if(nl<0)return;req=JSON.parse(data.subarray(0,nl));data=data.subarray(nl+1);}const n=req.size??0;if(data.length<n)return;const body=data.subarray(0,n);data=data.subarray(n);const r=req;req=null;handle(r,body);}});}
async function setup(mode='normal',remaining=60000){
 const parent=fs.mkdtempSync('/run/host-flow/attempt-'),fd=fs.openSync(parent+'/host.intent','wx+',0o600),monitor=await pair(),tpm=await pair(),abort=new AbortController();
 const calls=[],tpmCalls=[];let retained,body,owner;
 peerFrames(monitor.peer,(req,raw)=>{
  calls.push(req.cmd);let reply;
  if(req.cmd==='rpc-bootstrap-info')reply=structuredClone(info);
  else if(req.cmd==='rpc-bootstrap-attest'){retained=report(req.challenge);reply=structuredClone(retained);if(mode==='guest-change')reply.requestSha256='00'.repeat(32);}
  else if(req.cmd==='rpc-bootstrap-owner'){
   body=JSON.parse(raw);assert.deepEqual(Object.keys(body),['exportServerDer','hostEvidence','offer','ownerServerDer','policy']);assert.equal(Object.hasOwn(body,'evidence'),false);
   if(mode==='lost-ack'){monitor.peer.destroy();return;}
   const accepted=owner.accept(Buffer.from(JSON.stringify({schema:'enclave-rpc-owner-bootstrap-evidence/1',evidence:retained,hostEvidence:body.hostEvidence})),cert.raw);assert.equal(accepted.rpcReady,false);
   reply={ownerInputsPrepared:true,rootsGranted:false,rpcReady:false};
  }else if(req.cmd==='rpc-bootstrap-acquire')reply={acquisitionRequested:true,rootsGranted:false,rpcReady:false};
  else throw Error('unexpected command');
  monitor.peer.write(JSON.stringify(reply)+'\n');
 });
 let tpmbuf='';tpm.peer.on('data',b=>{tpmbuf+=b;for(;;){const nl=tpmbuf.indexOf('\n');if(nl<0)return;const cmd=tpmbuf.slice(0,nl);tpmbuf=tpmbuf.slice(nl+1);tpmCalls.push(cmd.split(' ')[0]);let reply;
  if(cmd==='keys')reply={'ek-cert':world.ek.cert.toString('hex'),'aik-pub':world.aik.tpmtPublic.toString('hex'),'aik-name':world.aik.name.toString('hex')};
  else if(cmd==='log'){if(mode==='blocked-tpm')return;reply={log};}
  else if(cmd.startsWith('activate ')){const [,blob,secret]=cmd.split(' ');reply={credential:activateCredential(world.ek.privateKey,world.aik.name,Buffer.from(blob,'hex'),Buffer.from(secret,'hex')).toString('hex')};}
  else if(cmd.startsWith('quote ')){const q=buildQuote({aikPriv:world.aik.privateKey,aikName:world.aik.name,pcrs:L.pcrs,pcr0:world.pcr0,extraData:Buffer.from(cmd.split(' ')[1],'hex')});reply={attest:q.attest.toString('hex'),sig:q.sig.toString('hex'),'aik-pub':mode==='changed-tpm'?'01':world.aik.tpmtPublic.toString('hex')};}
  else if(cmd==='pcr 0')reply={pcr:'0 '+world.pcr0.toString('hex')};else throw Error('unexpected TPM operation');
  tpm.peer.write(Object.entries(reply).map(([k,v])=>k+' '+v+'\r\n').join('')+'ok\r\n');
 }});
 const now=process.hrtime.bigint,deadline=now()+BigInt(remaining)*1000000n,original={originMonotonicNs:deadline-900000000000n,deadlineMonotonicNs:deadline},attempt=randomBytes(16).toString('hex');
 const expected={...Object.fromEntries(['appId','deployment','profile','l1Volume','baseVolume'].map(k=>[k,info.request[k]])),runtime:rid,manifestSha256:sha256(Buffer.from('{}')).toString('hex'),ownerAttempt:attempt,ownerKeys:pubs};
 const host=createRPCBootstrapHost({monitor:monitor.client,tpm:tpm.client,nodeKey:{spki:world.transport.spki,privateKey:world.transport.privateKey},journalFd:fd,expected,original,now,signal:abort.signal,ekChain:[b64(world.ca.inter)]});tpm.peer.write('ready synthetic-fixture\r\n');
 return {host,calls,tpmCalls,parent,fd,abort,async enroll(){const enrollment=await host.enroll();assert.deepEqual(enrollment.info,info);
  const n=Number(now()),cfg={parent,original:{attempt,boot:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),originMonotonicNs:n,deadlineMonotonicNs:n+900e9},request:info.request,runtime:rid,clientCertificate:info.certificate,keys:enrollment.keys,policy};owner=createOwnerBootstrap(cfg);
  const c=owner.challenge(),offer={attempt,challenge:c.challenge,clientCertificateSha256:sha256(cert.raw).toString('hex'),credentialBlob:c.credentialBlob,host:'127.0.0.1',hostNonce:c.hostNonce,manifestSha256:expected.manifestSha256,port:19944,requestSha256:info.requestSha256,runtime:rid,schema:'enclave-rpc-owner-offer/1',secret:c.secret,serverCertificateSha256:sha256(cert.raw).toString('hex'),serverName:'localhost'};
  const proof=signOwnerOffer(offer,seed(),pubs);return {proof,ownerServerDer:b64(cert.raw),exportServerDer:b64(cert.raw),policy:b64(Buffer.from('{}'))};
 },close(){host.close();owner?.close();monitor.peer.destroy();tpm.peer.destroy();fs.closeSync(fd);}};
}

test('host enrollment and hardware-command sequence feeds full owner verification once',async()=>{const f=await setup();try{const offer=await f.enroll();const result=await f.host.finish(offer);assert.equal(result.acquisitionRequested,true);assert.equal(result.rpcReady,false);assert.deepEqual(f.calls,['rpc-bootstrap-info','rpc-bootstrap-attest','rpc-bootstrap-owner','rpc-bootstrap-acquire']);assert.deepEqual(f.tpmCalls,['keys','log','activate','quote','pcr','keys']);assert.ok(fs.existsSync(f.parent+'/bootstrap/accepted.json'));await assert.rejects(f.host.finish(offer),/consumed/);await assert.rejects(f.host.enroll(),/consumed/);const lines=fs.readFileSync(f.parent+'/host.intent','utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(lines.map(x=>x.event),['host-bootstrap-intent','enrollment-intent','enrollment-complete','owner-offer-intent','owner-input-submit','acquire-submit','acquisition-requested']);assert.equal(lines.every(x=>x.rpcReady===false),true);}finally{f.close();}});

test('wrong owner or request refuses before TPM activation and remains consumed',async()=>{for(const what of ['signature','request']){const f=await setup();try{const offer=await f.enroll();if(what==='signature')offer.proof.l1='00'.repeat(64);else{offer.proof.offer.requestSha256='a1'.repeat(32);offer.proof=signOwnerOffer(offer.proof.offer,seed(),pubs);}await assert.rejects(f.host.finish(offer),/signature|enrollment/);assert.deepEqual(f.tpmCalls,['keys']);assert.deepEqual(f.calls,['rpc-bootstrap-info']);await assert.rejects(f.host.finish(offer),/consumed/);}finally{f.close();}}});

test('TPM or guest identity substitution never reaches installation',async()=>{for(const mode of ['changed-tpm','guest-change']){const f=await setup(mode);try{const offer=await f.enroll();await assert.rejects(f.host.finish(offer),/changed/);assert.equal(f.calls.includes('rpc-bootstrap-owner'),false);}finally{f.close();}}});

test('lost installation acknowledgment retains intent and does not acquire or retry',async()=>{const f=await setup('lost-ack');try{const offer=await f.enroll();await assert.rejects(f.host.finish(offer),/lost|ended/);assert.equal(f.calls.includes('rpc-bootstrap-acquire'),false);assert.match(fs.readFileSync(f.parent+'/host.intent','utf8'),/owner-input-submit/);await assert.rejects(f.host.finish(offer),/consumed/);}finally{f.close();}});

test('blocked TPM exchange is cut at original host deadline',async()=>{const f=await setup('blocked-tpm',400);try{const offer=await f.enroll(),started=Date.now();await assert.rejects(f.host.finish(offer),/expired|lost/);assert.ok(Date.now()-started<1200);assert.equal(f.calls.includes('rpc-bootstrap-attest'),false);}finally{f.close();}});

test('original supervisor loss closes both held transports',async()=>{const f=await setup('blocked-tpm');try{const offer=await f.enroll();const result=f.host.finish(offer);setTimeout(()=>f.abort.abort(),40);await assert.rejects(result,/lost|expired|closed/);assert.equal(f.calls.includes('rpc-bootstrap-attest'),false);}finally{f.close();}});
