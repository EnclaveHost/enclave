// Actual TLS and owner-minted TPM credential round trip; synthetic TPM/VBS only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import tls from 'node:tls';
import net from 'node:net';
import {once} from 'node:events';
import {execFileSync,spawn} from 'node:child_process';
import {forwardOwnerStream} from '../../rpc/server/owner_bootstrap_forward.mjs';
import {randomBytes,sign,constants,X509Certificate,generateKeyPairSync,verify} from 'node:crypto';
import {makeVbsWorld,tmpdir,buildLog,buildQuote} from '../fixtures/vbs-synthetic.mjs';
import {activateCredential} from '../../relay/vbs-credential.mjs';
import {hvNodeBinding} from '../../relay/hvnode-verify.mjs';
import {runtimeId} from '../../isolation/contract/runtime.mjs';
import {rpcBootstrapBinding,sha256} from '../../isolation/contract/rpc-bootstrap.mjs';
import {createOwnerBootstrap} from '../../rpc/server/owner_bootstrap_session.mjs';
import {listenOwnerBootstrap,receivePreparedRequest,reader} from '../../rpc/server/owner_bootstrap_transport.mjs';

process.umask(0o077);
const vector=JSON.parse(fs.readFileSync(process.env.RPC_BOOTSTRAP_VECTOR_DIR+'/bootstrap-vector.json'));
const world=makeVbsWorld(tmpdir('owner-tpm-'));
const image='ab'.repeat(32),identity={signer:'91'.repeat(32),productId:1818455653,moduleId:1734437220};
const b64=b=>b.toString('base64');
fs.mkdirSync('/run/owner-tests',{mode:0o700});
function tlsIdentity(name,usage){
 const p='/run/owner-tests/'+name;fs.mkdirSync(p,{mode:0o700});
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','ed25519','-nodes','-keyout',p+'/key','-out',p+'/cert','-days','1','-subj','/CN=localhost','-addext','basicConstraints=critical,CA:FALSE','-addext','subjectAltName=DNS:localhost','-addext','extendedKeyUsage='+usage],{stdio:'pipe',timeout:3000});
 const key=fs.readFileSync(p+'/key'),cert=fs.readFileSync(p+'/cert'),x=new X509Certificate(cert);return {key,cert,der:x.raw,spki:x.publicKey.export({type:'spki',format:'der'})};
}
const client=tlsIdentity('client','clientAuth'),server=tlsIdentity('server','serverAuth'),foreign=tlsIdentity('foreign','clientAuth');
const ownerKeys=[generateKeyPairSync('ed25519'),generateKeyPairSync('ed25519')];
const seeds=()=>ownerKeys.map(k=>Buffer.from(k.privateKey.export({format:'der',type:'pkcs8'}).subarray(-32)));
const publicKeys=ownerKeys.map(k=>k.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'));
const rid=runtimeId(vector.evidence.runtime).toString('hex');
const policy={schema:'enclave-rpc-bootstrap-policy/1',ekRoots:world.ca.bundlePem,platforms:'attested',minimumGuestSvn:5,images:[{rpcBootstrap:true,measurement:image,runtimeId:rid,profileSha256:vector.evidence.request.profile,identity}]};
function session(remaining=900000){
 const parent=fs.mkdtempSync('/run/owner-tests/attempt-'),now=Number(process.hrtime.bigint()),deadline=now+remaining*1e6;
 const cfg={parent,original:{attempt:randomBytes(16).toString('hex'),boot:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),originMonotonicNs:deadline-900e9,deadlineMonotonicNs:deadline},request:vector.evidence.request,runtime:rid,clientCertificate:b64(client.der),keys:{ek:b64(world.ek.cert),ekChain:[b64(world.ca.inter)],aikPub:b64(world.aik.tpmtPublic),aikName:b64(world.aik.name),transportKey:b64(world.transport.spki)},policy};
 return {cfg,s:createOwnerBootstrap(cfg)};
}
function evidence(s){
 const challenge=s.challenge(),hostNonce=Buffer.from(challenge.hostNonce,'base64');
 const credential=activateCredential(world.ek.privateKey,world.aik.name,Buffer.from(challenge.credentialBlob,'base64'),Buffer.from(challenge.secret,'base64'));
 const statement=Buffer.from('{}'),bound=hvNodeBinding(world.transport.spki,hostNonce,statement),L=buildLog({idksPub:world.idks.publicKey});
 const Q=buildQuote({aikPriv:world.aik.privateKey,aikName:world.aik.name,pcrs:L.pcrs,pcr0:world.pcr0,extraData:sha256(bound)});
 const hostEvidence={statement:b64(statement),signature:b64(sign(null,bound,world.transport.privateKey)),log:b64(L.log),quote:{attest:b64(Q.attest),sig:b64(Q.sig),aikPub:b64(world.aik.tpmtPublic)},credential:b64(credential),ek:{cert:b64(world.ek.cert),chain:[b64(world.ca.inter)]},pcr0:world.pcr0.toString('hex')};
 const e={...structuredClone(vector.evidence),certificate:b64(client.der),transportKey:b64(client.spki),challenge:challenge.challenge};
 const binding=rpcBootstrapBinding({request:e.request,spki:client.spki,certificate:client.der,challenge:Buffer.from(e.challenge,'hex'),runtime:Buffer.from(rid,'hex')});
 const claims=Buffer.from(JSON.stringify({'user-data':binding.toString('hex')+e.request.appId})),env=Buffer.alloc(1236+claims.length),w=(o,n)=>env.writeUInt32LE(n,o);
 w(0,0x414c4348);w(4,2);w(8,env.length);w(12,2);w(1216,20+claims.length);w(1220,1);w(1224,1);w(1228,1);w(1232,claims.length);claims.copy(env,1236);
 const r=env.subarray(32,592);[560,1,1,256,0,2].forEach((n,i)=>r.writeUInt32LE(n,i*4));sha256(claims).copy(r,24);Buffer.from(image,'hex').copy(r,120);Buffer.from(identity.signer,'hex').copy(r,152);r.writeUInt32LE(5,216);r.writeUInt32LE(2,224);r.writeUInt32LE(5,228);r.writeUInt32LE(identity.productId,232);r.writeUInt32LE(identity.moduleId,236);
 sign('sha256',r.subarray(0,304),{key:world.idks.privateKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).copy(r,304);e.vbsVmReport=b64(env);
 return {schema:'enclave-rpc-owner-bootstrap-evidence/1',evidence:e,hostEvidence};
}
const wire=x=>Buffer.from(JSON.stringify(x));
function send(socket,raw){const head=Buffer.alloc(4);head.writeUInt32BE(raw.length);socket.write(Buffer.concat([head,raw]));}
async function port(){const srv=net.createServer();srv.listen(0,'127.0.0.1');await once(srv,'listening');const p=srv.address().port;await new Promise(r=>srv.close(r));return p;}
async function listen(s,schema="enclave-rpc-owner-offer/1"){return listenOwnerBootstrap(s,{host:'127.0.0.1',port:await port(),...server,ownerOffer:{schema,seeds:seeds(),publicKeys,runtime:rid,manifestSha256:sha256(Buffer.from("{}")).toString("hex"),serverName:"localhost"}});}
async function connect(t,who=client){
 const socket=tls.connect({host:'127.0.0.1',port:t.server.address()?.port??t.port,servername:'localhost',ca:server.cert,key:who.key,cert:who.cert,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'});socket.on('error',()=>{});
 const read=reader(socket);await once(socket,'secureConnect');return {socket,read};
}

test('owner-minted credential and actual pinned TLS admit exactly the prepared request',async()=>{
 const {cfg,s}=session(),t=await listen(s);t.port=t.server.address().port;
 const {socket,read}=await connect(t);
 try{
  const proof=JSON.parse(fs.readFileSync(cfg.parent+'/bootstrap/public-challenge.json'));
  for(const [role,sig] of [proof.l1,proof.base].entries()){const payload=Buffer.concat([Buffer.from('ENCLAVE-RPC-OWNER-ENDPOINT/1\0'),Buffer.from([role]),sha256(wire(proof.offer))]);assert.equal(verify(null,payload,ownerKeys[role].publicKey,Buffer.from(sig,'hex')),true);}
  fs.writeFileSync(process.env.RPC_BOOTSTRAP_VECTOR_DIR+'/owner-offer-vector.json',JSON.stringify({proof,publicKeys}));
  assert.equal(socket.authorized,true);send(socket,wire(evidence(s)));
  const reply=JSON.parse(await read(65536)),connection=await t.accepted;
  assert.equal(reply.certificateSha256,sha256(client.der).toString('hex'));assert.equal(reply.rpcReady,false);
  assert.ok(fs.existsSync(cfg.parent+'/bootstrap/accepted-evidence.json'));assert.ok(fs.existsSync(cfg.parent+'/bootstrap/accepted.json'));
  const prepared=wire({bundle:'ZHVtbXk=',manifest:'e30=',request:cfg.request});
  send(socket,prepared);assert.deepEqual(await receivePreparedRequest(s,connection,prepared),prepared);
  assert.ok(fs.existsSync(cfg.parent+'/bootstrap/dispatch.intent'));
  assert.throws(()=>s.accept(wire({}),client.der),/consumed/);
  assert.throws(()=>createOwnerBootstrap(cfg),/EEXIST/);
 }finally{socket.destroy();t.close();}
});
test('forged minted credential and substituted TLS certificate consume without dispatch',()=>{
 for(const mode of ['credential','certificate','challenge']){
  const {cfg,s}=session(),m=evidence(s);
  if(mode==='credential')m.hostEvidence.credential=b64(randomBytes(32));
  if(mode==='challenge')m.evidence.challenge='9'.repeat(64);
  assert.throws(()=>s.accept(wire(m),mode==='certificate'?foreign.der:client.der),/refused/);
  assert.ok(fs.existsSync(cfg.parent+'/bootstrap/verify.intent'));assert.ok(!fs.existsSync(cfg.parent+'/bootstrap/accepted.json'));
  assert.throws(()=>s.accept(wire(m),client.der),/consumed/);
 }
});
test('foreign TLS client cannot reach evidence acceptance and first connection consumes listener',async()=>{
 const {cfg,s}=session(),t=await listen(s);t.port=t.server.address().port;
 let socket;
 try{
  try{({socket}=await connect(t,foreign));send(socket,wire(evidence(s)));}catch{}
  await assert.rejects(t.accepted);
  assert.ok(!fs.existsSync(cfg.parent+'/bootstrap/verify.intent'));assert.equal(t.server.listening,false);
 }finally{socket?.destroy();t.close();}
});
test('no client reaches original absolute deadline and rejects pending acceptance',async()=>{
 const {s}=session(180),t=await listen(s),start=process.hrtime.bigint();
 try{await assert.rejects(t.accepted,/deadline/);assert.ok(Number(process.hrtime.bigint()-start)/1e6<700);assert.equal(t.server.listening,false);}finally{t.close();}
});
test('authenticated slow request remains bounded by the original deadline',async()=>{
 const {cfg,s}=session(700),m=evidence(s),t=await listen(s);t.port=t.server.address().port;
 const {socket,read}=await connect(t);
 try{
  send(socket,wire(m));await read(65536);const connection=await t.accepted;
  const result=receivePreparedRequest(s,connection,wire({request:cfg.request}));
  const head=Buffer.alloc(4);head.writeUInt32BE(100);socket.write(head);
  const drip=setInterval(()=>socket.write(' '),30);
  try{await assert.rejects(result,/deadline|incomplete/);}finally{clearInterval(drip);}
  assert.ok(!fs.existsSync(cfg.parent+'/bootstrap/dispatch.intent'));
 }finally{socket.destroy();t.close();}
});
test('wrong complete request and malformed first frame never consume dispatch',async()=>{
 for(const mode of ['request','frame']){
  const {cfg,s}=session(),t=await listen(s);t.port=t.server.address().port;const {socket,read}=await connect(t);
  try{
   if(mode==='frame'){socket.write(Buffer.alloc(4));await assert.rejects(t.accepted,/frame bound/);}
   else{send(socket,wire(evidence(s)));await read(65536);const connection=await t.accepted;send(socket,wire({wrong:true}));await assert.rejects(receivePreparedRequest(s,connection,wire({expected:true})),/differs/);}
   assert.ok(!fs.existsSync(cfg.parent+'/bootstrap/dispatch.intent'));
  }finally{socket.destroy();t.close();}
 }
});

test('explicit owner/2 signature and acknowledgement preserve stream negotiation',async()=>{
 const {cfg,s}=session(),t=await listen(s,'enclave-rpc-owner-offer/2');t.port=t.server.address().port;
 const {socket,read}=await connect(t);
 try{
  assert.equal(t.proof.offer.schema,'enclave-rpc-owner-offer/2');
  for(const [role,sig] of [t.proof.l1,t.proof.base].entries()){
   const payload=Buffer.concat([Buffer.from('ENCLAVE-RPC-OWNER-ENDPOINT/1\0'),Buffer.from([role]),sha256(wire(t.proof.offer))]);
   assert.equal(verify(null,payload,ownerKeys[role].publicKey,Buffer.from(sig,'hex')),true);
   const downgraded={...t.proof.offer,schema:'enclave-rpc-owner-offer/1'};
   const wrong=Buffer.concat([Buffer.from('ENCLAVE-RPC-OWNER-ENDPOINT/1\0'),Buffer.from([role]),sha256(wire(downgraded))]);
   assert.equal(verify(null,wrong,ownerKeys[role].publicKey,Buffer.from(sig,'hex')),false);
  }
  fs.writeFileSync(process.env.RPC_BOOTSTRAP_VECTOR_DIR+'/owner-offer-v2-vector.json',JSON.stringify({proof:t.proof,publicKeys}));
  send(socket,wire(evidence(s)));const reply=JSON.parse(await read(65536));await t.accepted;
  assert.equal(reply.schema,'enclave-rpc-owner-bootstrap-accepted/2');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg.parent+'/bootstrap/protocol-accepted.json')),reply);
 }finally{socket.destroy();t.close();}
});

const streamStub=`import sys,struct,json,time
initial=bytes.fromhex(sys.argv[1]);mode=sys.argv[2]
def send(x):
 sys.stdout.buffer.write(struct.pack('!I',len(x))+x);sys.stdout.buffer.flush()
send(initial)
if mode=='unsolicited':
 time.sleep(.03);sys.stdout.buffer.write(b'x');sys.stdout.buffer.flush();time.sleep(2)
if mode=='death':
 time.sleep(.03);sys.exit(7)
while True:
 header=sys.stdin.buffer.read(4)
 if not header:break
 n=struct.unpack('!I',header)[0];raw=sys.stdin.buffer.read(n)
 if mode=='stall':time.sleep(3)
 send(raw)
`;
for(const mode of ['normal','death','unsolicited','stall'])test('continuous TLS wrapper '+mode,async()=>{
 const {cfg,s}=session(mode==='stall'?900:3000),t=await listen(s,'enclave-rpc-owner-offer/2');t.port=t.server.address().port;
 const {socket,read}=await connect(t);let child,done;
 try{
  send(socket,wire(evidence(s)));await read(65536);const connection=await t.accepted;
  const prepared=wire({bundle:'ZHVtbXk=',manifest:'e30=',request:cfg.request});send(socket,prepared);await receivePreparedRequest(s,connection,prepared);
  const initial=wire({schema:'enclave-rpc-owner-dispatched/2',attempt:cfg.original.attempt,proof:b64(Buffer.from('inert signed-proof placeholder')),rpcReady:false,writersFenced:false,reservationMayRelease:false});
  child=spawn('/usr/bin/python3',['-B','-c',streamStub,initial.toString('hex'),mode],{stdio:['pipe','pipe','pipe']});
  done=forwardOwnerStream(s,connection,child);done.catch(()=>{});
  assert.deepEqual(await read(65536),initial);
  if(mode==='normal'){
   for(let i=1;i<=2;i++){const request=wire({sequence:i,synthetic:true});send(socket,request);assert.deepEqual(await read(2048),request);}
   assert.ok(fs.existsSync(cfg.parent+'/bootstrap/continuation-0000000000000002-wire-response'));socket.destroy();
  }else if(mode==='stall')send(socket,wire({synthetic:true}));
  await assert.rejects(done,/lost|expired|incomplete/);
 }finally{
  socket.destroy();t.close();child?.kill('SIGKILL');
  if(child&&child.exitCode===null&&child.signalCode===null)await once(child,'close');
 }
});
