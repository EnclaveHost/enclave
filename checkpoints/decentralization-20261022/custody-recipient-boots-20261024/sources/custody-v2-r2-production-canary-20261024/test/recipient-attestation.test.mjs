// Not production SNP evidence: mocked judge cases and real local self-signed TLS transport fixtures.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import https from 'node:https';import {execFileSync} from 'node:child_process';import {X509Certificate} from 'node:crypto';
import {sha256hex} from '../driver/canonical.mjs';
import {attestRecipient,fetchRecipientEvidence,verifyLiveRecipient} from '../driver/recipient-attestation.mjs';
function fixture(){
 const id='0x'+'12'.repeat(32),spki=Buffer.from('synthetic-peer-spki'),nonce=Buffer.alloc(32,7),image={appId:'a'.repeat(64),runtimeId:'b'.repeat(64),measurement:'c'.repeat(96),minTcb:{Genoa:{bootloader:10,tee:0,snp:23,microcode:84},Turin:{fmc:1,bootloader:3,tee:2,snp:5,microcode:117}}};
 const recipient={status:'recipient-observed',attemptDigest:'d'.repeat(64),custodianWindowDigest:'e'.repeat(64),identity:{id,appId:image.appId,runtimeId:image.runtimeId,measurement:image.measurement},instance:{id:'gdabcdef01',name:id,appId:image.appId,runtimeId:image.runtimeId,measurement:image.measurement,transportKeySha256:sha256hex(spki)},process:{pid:10,startTicks:'20'}};
 const doc={format:'sev-snp-guest-domain-v1',abi:'enclave-domain-abi/2',nonce:nonce.toString('hex'),transportKey:spki.toString('base64'),runtime:{mock:'runtime'},report:Buffer.alloc(1184,3).toString('base64')};
 const verdict={verdict:'attested',gateOpen:true,vmpl:0,tcb:{checked:true},measurement:image.measurement,hostData:id.slice(2),runtime:doc.runtime};
 const f={id,pins:{image},recipient,doc,verdict,spki,nonce,now:()=>1000,rng:()=>nonce,runtimeId:()=>Buffer.from(image.runtimeId,'hex'),parseSnpReport:()=>({vmpl:0,policy:0n})};
 f.fetchEvidence=async()=>({doc:f.doc,spki:f.spki});f.judge=async(d,key,n,want)=>{assert.equal(d,doc);assert.deepEqual(key,spki);assert.deepEqual(n,nonce);assert.equal(want.mode,'trusted');assert.equal(want.kds,false);assert.equal(want.expectedVmpl,0);assert.equal(want.hostData,id);assert.equal(want.appSha,image.appId);assert.deepEqual(want.minTcb,image.minTcb);return f.verdict;};return f;
}
test('fresh recipient quote must bind the observed transport key, exact deployment and pinned runtime without KDS fallback',async()=>{
 const f=fixture(),r=await attestRecipient(f);assert.equal(r.status,'recipient-attested');assert.equal(r.expectedVmpl,0);assert.equal(r.kdsFallback,false);assert.equal(r.transportKeySha256,sha256hex(f.spki));assert.equal(r.outcome,undefined);assert.ok(!JSON.stringify(r).includes(f.doc.report));assert.ok(!JSON.stringify(r).includes('synthetic-peer-spki'));
});
test('different TLS key, nonce, runtime, image, host data, ABI, privilege, policy or unverified quote refuse',async()=>{
 const changes=[f=>f.spki=Buffer.from('other-key'),f=>f.doc.nonce='0'.repeat(64),f=>f.doc.transportKey=Buffer.from('other-key').toString('base64'),f=>f.runtimeId=()=>Buffer.alloc(32),f=>f.recipient.identity.appId='e'.repeat(64),f=>f.doc.abi='enclave-domain-abi/1',f=>f.doc.format='sev-snp-svsm-plane-v1',f=>f.parseSnpReport=()=>({vmpl:2,policy:0n}),f=>f.parseSnpReport=()=>({vmpl:0,policy:1n<<19n}),f=>f.parseSnpReport=()=>({vmpl:0,policy:1n<<18n}),f=>f.verdict.hostData='0'.repeat(64),f=>f.verdict.verdict='unauthenticated',f=>f.verdict.gateOpen=false,f=>f.verdict.tcb.checked=false,f=>f.pins.image.minTcb.Genoa.snp=0,f=>f.doc.report='not-base64',f=>f.doc.certs=Buffer.alloc(131073).toString('base64')];
 for(const change of changes){const f=fixture();change(f);await assert.rejects(()=>attestRecipient(f),/fresh pinned hardware evidence unavailable or inconsistent/);}
});
test('transport/verifier errors never expose raw peer details, and expired quote checks refuse',async()=>{
 for(const key of ['fetchEvidence','judge']){const f=fixture();f[key]=async()=>{throw Error('private-peer-error-payload');};await assert.rejects(()=>attestRecipient(f),e=>!e.message.includes('private-peer-error-payload'));}
 const f=fixture();let n=0;f.now=()=>n++?122001:1000;await assert.rejects(()=>attestRecipient(f));
});
test('live wrapper rejects stale quotes or recipient replacement during quote verification',async()=>{
 const f=fixture(),quote=await attestRecipient(f),args={id:f.id,pins:f.pins,observeRecipient:async()=>structuredClone(f.recipient),attest:async()=>quote,now:()=>1000};
 assert.equal((await verifyLiveRecipient(args)).status,'recipient-verified');
 await assert.rejects(()=>verifyLiveRecipient({...args,attest:async()=>({...quote,requestedAt:999})}));
 await assert.rejects(()=>verifyLiveRecipient({...args,attest:async()=>({...quote,transportKeySha256:'f'.repeat(64)})}));
 let n=0;await assert.rejects(()=>verifyLiveRecipient({...args,observeRecipient:async()=>{const r=structuredClone(f.recipient);if(n++)r.process.startTicks='replacement';return r;}}));
});
async function tlsFixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recipient-quote-tls-')),key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','ed25519','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore',timeout:10000});
 let respond=(req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({nonce:new URL(req.url,'https://localhost').searchParams.get('nonce')}));},hits=0;
 const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{hits++;respond(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true});});
 const spki=new X509Certificate(fs.readFileSync(cert)).publicKey.export({type:'spki',format:'der'});
 const requestImpl=(opts,cb)=>{assert.equal(opts.rejectUnauthorized,false);assert.equal(opts.agent,false);assert.equal(opts.method,'GET');assert.equal(opts.hostname,'12121212.app.enclave.host');return https.request({...opts,hostname:'127.0.0.1',port:server.address().port,servername:'localhost'},cb);};
 return {spki,requestImpl,set:f=>respond=f,hits:()=>hits};
}
test('real TLS transport captures the actual peer key and refuses redirects, non-JSON and oversized data',async t=>{
 const f=await tlsFixture(t),args={id:'0x'+'12'.repeat(32),nonce:Buffer.alloc(32,7),requestImpl:f.requestImpl},r=await fetchRecipientEvidence(args);assert.deepEqual(r.spki,f.spki);assert.equal(r.doc.nonce,args.nonce.toString('hex'));
 for(const respond of [(_q,s)=>{s.writeHead(302,{location:'https://other.example'});s.end();},(_q,s)=>{s.writeHead(200,{'content-type':'text/plain'});s.end('private-bad-data');},(_q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end(Buffer.alloc(262145,65));}]){f.set(respond);const before=f.hits();await assert.rejects(()=>fetchRecipientEvidence(args),e=>e.message==='recipient evidence transport unavailable or invalid');assert.equal(f.hits(),before+1);}
});
