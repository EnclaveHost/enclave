// Actual protected files, TPM credential mint and TLS listener; synthetic TPM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,randomBytes,X509Certificate,verify} from 'node:crypto';
import {makeVbsWorld,tmpdir} from '../fixtures/vbs-synthetic.mjs';
import {runtimeId} from '../../isolation/contract/runtime.mjs';
import {sha256,rpcStorageRequestBytes} from '../../isolation/contract/rpc-bootstrap.mjs';
import {createOwnerBootstrap} from '../../rpc/server/owner_bootstrap_session.mjs';
import {listenOwnerBootstrap} from '../../rpc/server/owner_bootstrap_transport.mjs';
import {validateEnrollment,publishHostOffer} from '../../rpc/server/owner_bootstrap_enrollment.mjs';
import {offerBytes} from '../../rpc/server/owner_bootstrap_offer.mjs';
process.umask(0o077);
const world=makeVbsWorld(tmpdir('enrollment-tpm-')),vector=JSON.parse(fs.readFileSync(process.env.RPC_BOOTSTRAP_VECTOR_DIR+'/bootstrap-vector.json'));
const root=fs.mkdtempSync('/run/enrollment-'),b64=b=>b.toString('base64');
function identity(name,usage){const p=root+'/'+name;fs.mkdirSync(p);execFileSync('/usr/bin/openssl',['req','-x509','-newkey','ed25519','-nodes','-keyout',p+'/key','-out',p+'/cert','-days','1','-subj','/CN=localhost','-addext','basicConstraints=critical,CA:FALSE','-addext','subjectAltName=DNS:localhost','-addext','extendedKeyUsage='+usage],{stdio:'pipe',timeout:3000});const cert=fs.readFileSync(p+'/cert'),x=new X509Certificate(cert);return {key:fs.readFileSync(p+'/key'),cert,der:x.raw,spki:x.publicKey.export({type:'spki',format:'der'})};}
const client=identity('client','clientAuth'),server=identity('server','serverAuth');
const owners=[generateKeyPairSync('ed25519'),generateKeyPairSync('ed25519')],publicKeys=owners.map(k=>k.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex'));
function config(){const now=Number(process.hrtime.bigint()),info={...structuredClone(vector.evidence)};delete info.challenge;delete info.vbsVmReport;info.certificate=b64(client.der);info.transportKey=b64(client.spki);info.requestSha256=sha256(rpcStorageRequestBytes(info.request)).toString('hex');const keys={ek:b64(world.ek.cert),ekChain:[b64(world.ca.inter)],aikPub:b64(world.aik.tpmtPublic),aikName:b64(world.aik.name),transportKey:b64(world.transport.spki)};return {parent:fs.mkdtempSync(root+'/attempt-'),original:{attempt:randomBytes(16).toString('hex'),boot:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),originMonotonicNs:now,deadlineMonotonicNs:now+900e9},request:info.request,runtime:runtimeId(info.runtime).toString('hex'),clientCertificate:info.certificate,keys,policy:{schema:'enclave-rpc-bootstrap-policy/1',ekRoots:world.ca.bundlePem},enrollment:{candidate:{info,keys},receiptSha256:'e'.repeat(64)}};}
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('enrollment becomes a durable complete doubly signed host offer without authentication or root grant',async()=>{
 const cfg=config(),enrollment=validateEnrollment(cfg),s=createOwnerBootstrap(cfg),seeds=owners.map(k=>Buffer.from(k.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32)));
 let t;
 try{t=await listenOwnerBootstrap(s,{host:'127.0.0.1',port:await port(),...server,ownerOffer:{seeds,publicKeys,runtime:cfg.runtime,manifestSha256:'d'.repeat(64),serverName:'localhost'}});
 const delivery={exportServerDer:b64(server.der),policy:b64(Buffer.from('{}'))},raw=publishHostOffer(s,{proof:t.proof,certificate:server.cert,delivery,enrollment}),offer=JSON.parse(raw);
 assert.equal(fs.readFileSync(cfg.parent+'/bootstrap/host-offer.json').equals(raw),true);assert.equal(fs.statSync(cfg.parent+'/bootstrap/host-offer.json').nlink,1);assert.equal(fs.existsSync(cfg.parent+'/bootstrap/host-offer.pending'),false);assert.equal(enrollment.guestAuthenticated,false);assert.equal(fs.existsSync(cfg.parent+'/bootstrap/accepted.json'),false);
 assert.deepEqual(Object.keys(offer).sort(),['exportServerDer','ownerServerDer','policy','proof']);assert.equal(raw.includes(Buffer.from('PRIVATE KEY')),false);
 for(const [role,sig] of [offer.proof.l1,offer.proof.base].entries())assert.equal(verify(null,Buffer.concat([Buffer.from('ENCLAVE-RPC-OWNER-ENDPOINT/1\0'),Buffer.from([role]),sha256(offerBytes(offer.proof.offer))]),owners[role].publicKey,Buffer.from(sig,'hex')),true);
 assert.ok(seeds.every(b=>b.every(n=>n===0)));assert.throws(()=>publishHostOffer(s,{proof:t.proof,certificate:server.cert,delivery,enrollment}),/EEXIST/);
 }finally{t?.close();s.close();}
});
test('changed runtime request certificate and SPKI refuse before challenge mint',()=>{
 for(const change of [c=>c.runtime='f'.repeat(64),c=>c.request={...c.request,nonce:'f'.repeat(64)},c=>c.enrollment.candidate.info.transportKey=b64(world.transport.spki),c=>c.enrollment.candidate.info.certificate=b64(Buffer.concat([client.der,Buffer.from('extra')])),c=>c.enrollment.candidate.info.rpcReady=true]){const c=config();change(c);assert.throws(()=>validateEnrollment(c));assert.equal(fs.existsSync(c.parent+'/bootstrap'),false);}
});
test('offer for another enrolled request cannot become host input',()=>{
 const c=config(),s=createOwnerBootstrap(c),enrollment=validateEnrollment(c);
 try{assert.throws(()=>publishHostOffer(s,{proof:{offer:{serverCertificateSha256:sha256(server.der).toString('hex'),requestSha256:'f'.repeat(64)}},certificate:server.cert,delivery:{exportServerDer:b64(server.der),policy:b64(Buffer.from('{}'))},enrollment}),/differs/);assert.equal(fs.existsSync(c.parent+'/bootstrap/host-offer.json'),false);}finally{s.close();}
});
