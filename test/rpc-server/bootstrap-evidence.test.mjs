// Cryptographic synthetic TPM/VBS fixtures, not target Windows evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomBytes,sign,constants,generateKeyPairSync} from 'node:crypto';
import {makeVbsWorld,tmpdir,buildLog,buildQuote,haveOpenssl} from '../fixtures/vbs-synthetic.mjs';
import {hvNodeBinding} from '../../relay/hvnode-verify.mjs';
import {runtimeId,bind2} from '../../isolation/contract/runtime.mjs';
import {rpcBootstrapBinding,rpcStorageRequestBytes,sha256} from '../../isolation/contract/rpc-bootstrap.mjs';
import {verifyRPCBootstrap} from '../../rpc/server/verify_bootstrap.mjs';
assert.ok(haveOpenssl,'required crypto fixture tool is present');
assert.ok(process.env.RPC_BOOTSTRAP_VECTOR_DIR,'actual Go public vector required');
const vector=JSON.parse(fs.readFileSync(process.env.RPC_BOOTSTRAP_VECTOR_DIR+'/bootstrap-vector.json'));
const world=makeVbsWorld(tmpdir('rpc-bootstrap-'));
const image='ab'.repeat(32),identity={signer:'91'.repeat(32),productId:1818455653,moduleId:1734437220};
const b64=b=>b.toString('base64');
function fixture({ordinary=false,signer=world.idks.privateKey,debug=0,boot={}}={}){
 const hostNonce=randomBytes(32),credential=randomBytes(32),statement=Buffer.from('{}');
 const bound=hvNodeBinding(world.transport.spki,hostNonce,statement);
 const L=buildLog({idksPub:world.idks.publicKey,...boot});
 const Q=buildQuote({aikPriv:world.aik.privateKey,aikName:world.aik.name,pcrs:L.pcrs,pcr0:world.pcr0,extraData:sha256(bound)});
 const evidence={statement:b64(statement),signature:b64(sign(null,bound,world.transport.privateKey)),log:b64(L.log),quote:{attest:b64(Q.attest),sig:b64(Q.sig),aikPub:b64(world.aik.tpmtPublic)},credential:b64(credential),ek:{cert:b64(world.ek.cert),chain:[b64(world.ca.inter)]},pcr0:world.pcr0.toString('hex')};
 const e=structuredClone(vector.evidence),spki=Buffer.from(e.transportKey,'base64'),cert=Buffer.from(e.certificate,'base64'),nonce=Buffer.from(e.challenge,'hex'),rid=runtimeId(e.runtime);
 let input=Buffer.from(vector.reportData,'hex');if(ordinary)input=Buffer.concat([bind2(spki,nonce,rid),Buffer.from(e.request.appId,'hex')]);
 const claims=Buffer.from(JSON.stringify({'user-data':input.toString('hex')})),env=Buffer.alloc(1236+claims.length),w=(o,n)=>env.writeUInt32LE(n,o);
 w(0,0x414c4348);w(4,2);w(8,env.length);w(12,2);w(1216,20+claims.length);w(1220,1);w(1224,1);w(1228,1);w(1232,claims.length);claims.copy(env,1236);
 const r=env.subarray(32,592);[560,1,1,256,0,2].forEach((n,i)=>r.writeUInt32LE(n,i*4));sha256(claims).copy(r,24);Buffer.from(image,'hex').copy(r,120);r.writeUInt32LE(5,216);r.writeUInt32LE(debug,220);r.writeUInt32LE(2,224);r.writeUInt32LE(5,228);
 Buffer.from(identity.signer,'hex').copy(r,152);r.writeUInt32LE(identity.productId,232);r.writeUInt32LE(identity.moduleId,236);
 sign('sha256',r.subarray(0,304),{key:signer,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).copy(r,304);
 e.vbsVmReport=b64(env);
 return {evidence:e,expectedRequest:structuredClone(e.request),expectedRuntimeId:rid.toString('hex'),challenge:nonce,handshakeCertificate:cert,hostSession:{evidence,nonce:hostNonce,transportKeySpki:world.transport.spki,expectedCredential:credential,mintedFor:{ekCert:world.ek.cert,aikName:world.aik.name}}};
}
const policy={schema:'enclave-rpc-bootstrap-policy/1',ekRoots:world.ca.bundlePem,platforms:'attested',minimumGuestSvn:5,images:[{rpcBootstrap:true,measurement:image,runtimeId:runtimeId(vector.evidence.runtime).toString('hex'),profileSha256:vector.evidence.request.profile,identity}]};
const run=(f,p=policy)=>verifyRPCBootstrap(f,p);
test('actual Go guest binding and JS owner binding are byte-identical',()=>{
 const e=vector.evidence;const binding=rpcBootstrapBinding({request:e.request,spki:Buffer.from(e.transportKey,'base64'),certificate:Buffer.from(e.certificate,'base64'),challenge:Buffer.from(e.challenge,'hex'),runtime:runtimeId(e.runtime)});
 assert.equal(binding.toString('hex')+e.request.appId,vector.reportData);
 assert.equal(sha256(rpcStorageRequestBytes(e.request)).toString('hex'),e.requestSha256);
});
test('complete synthetic TPM chain verifies the guest bootstrap purpose only',()=>{
 const f=fixture(),v=run(f);assert.equal(v.ok,true,v.reason);assert.equal(v.purpose,'enclave-rpc-storage-bootstrap/1');assert.equal(v.rootsGranted,false);assert.equal(v.rpcReady,false);assert.equal(v.hostExcluded,false);assert.equal(v.admissible,undefined);assert.equal(v.certificateSha256,sha256(f.handshakeCertificate).toString('hex'));
});
test('request, TLS key, certificate and challenge substitution are refused',()=>{
 const good=fixture();assert.equal(run(good).ok,true,run(good).reason);
 for(const mode of ['purpose','ready','roots','extra','appId','baseVolume','l1Volume','profile','nonce','deployment','boot','clock','requestSha256','runtime','challenge','peerCert','key','cert','report']){
  const f=structuredClone(good);f.challenge=Buffer.from(good.challenge);f.handshakeCertificate=Buffer.from(good.handshakeCertificate);f.hostSession=good.hostSession;
  const e=f.evidence;
  if(['appId','baseVolume','l1Volume','profile','nonce'].includes(mode)){e.request[mode]='9'.repeat(64);f.expectedRequest[mode]=e.request[mode];e.requestSha256=sha256(rpcStorageRequestBytes(e.request)).toString('hex');if(mode==='profile'){/* independent policy also refuses */}}
  else switch(mode){case 'purpose':e.purpose='enclave-shield-secrets/1';break;case 'ready':e.rpcReady=true;break;case 'roots':e.rootsGranted=true;break;case 'extra':e.privateKey='forbidden';break;case 'deployment':e.request.deployment='0x'+'9'.repeat(64);break;case 'boot':e.request.boot='99999999-2222-3333-4444-555555555555';break;case 'clock':e.request.originMonotonicNs++;e.request.deadlineMonotonicNs++;break;case 'requestSha256':e.requestSha256='9'.repeat(64);break;case 'runtime':e.runtime.version='wrong';break;case 'challenge':f.challenge=randomBytes(32);break;case 'peerCert':f.handshakeCertificate=Buffer.from('wrong');break;case 'key':e.transportKey=b64(Buffer.alloc(44));break;case 'cert':e.certificate=b64(Buffer.from('not cert'));break;case 'report':e.vbsVmReport=b64(Buffer.from('launcher JSON'));break;}
  assert.equal(run(f).ok,false,mode);
 }
});
test('requires exact owner-selected image, profile, runtime and signer pair',()=>{
 const f=fixture();assert.equal(run(f).ok,true,run(f).reason);
 for(const mode of ['schema','roots','platform','images','purpose','profile','runtime','measurement','signer','product','module','svn']){
  const p=structuredClone(policy);switch(mode){case 'schema':p.schema='enclave-shield-app-policy/1';break;case 'roots':p.ekRoots='';break;case 'platform':p.platforms=[];break;case 'images':p.images=[];break;case 'purpose':p.images[0].rpcBootstrap=false;break;case 'profile':p.images[0].profileSha256='9'.repeat(64);break;case 'runtime':p.images[0].runtimeId='9'.repeat(64);break;case 'measurement':p.images[0].measurement='9'.repeat(64);break;case 'signer':p.images[0].identity.signer='9'.repeat(64);break;case 'product':p.images[0].identity.productId++;break;case 'module':p.images[0].identity.moduleId++;break;case 'svn':p.minimumGuestSvn=6;break;}
  const verdict=run(f,p);assert.equal(verdict.ok,false,mode);if(['signer','product','module'].includes(mode)){assert.equal(verdict.checks.signature,true);assert.equal(verdict.checks['image-identity'],false);}if(mode==='svn'){assert.equal(verdict.checks.svn,false);assert.equal(verdict.checks['user-data'],true);}
 }
});
test('ordinary app reports, foreign boot signatures and debug boot do not bootstrap storage',()=>{
 for(const [f,reason] of [[fixture({ordinary:true}),/guest binding differs/],[fixture({signer:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey}),/signature failed/],[fixture({debug:1}),/debug-enabled/],[fixture({boot:{secureBoot:0}}),/host boot/]]){const verdict=run(f);assert.equal(verdict.ok,false);assert.match(verdict.reason,reason);}
 const f=fixture();assert.equal(run({...f,hostSession:{...f.hostSession,capture:{}}}).ok,false);assert.equal(run({...f,hostSession:null}).ok,false);
});
test('exact canonical request refuses unsafe integers and unknown authority fields',()=>{
 const r=vector.evidence.request;
 for(const value of [{...r,permission:true},{...r,originMonotonicNs:9007199254740992,deadlineMonotonicNs:9008099254740992},{...r,deadlineMonotonicNs:r.deadlineMonotonicNs+1},{...r,boot:'00000000-0000-0000-0000-000000000000'},{...r,nonce:'0'.repeat(64)},{...r,baseVolume:r.l1Volume}])assert.throws(()=>rpcStorageRequestBytes(value));
});
