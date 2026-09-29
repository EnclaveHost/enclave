import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, sign, constants, generateKeyPairSync } from 'node:crypto';
import { verifyVbsAppEvidence } from '../relay/vbs-app-verify.mjs';
import { hvNodeBinding } from '../relay/hvnode-verify.mjs';
import { ABI2, bind2, runtimeId } from '../isolation/contract/runtime.mjs';
import { haveOpenssl, tmpdir, makeVbsWorld, buildLog, buildQuote } from './fixtures/vbs-synthetic.mjs';
const sha = b => createHash('sha256').update(b).digest(), b64 = b => b.toString('base64');
const world = haveOpenssl ? makeVbsWorld(tmpdir('vbs-app-')) : null;
const image = 'ab'.repeat(32), app = 'cd'.repeat(32);
const runtime = {name:'wasmtime',version:'48.0.1',execution:'jit',targetIsa:'x86_64',hostIsa:'x86_64',cpuFeatures:'host-detected',wx:'enforced',cache:'none'};
function fixture({ boot = {}, signer = world.idks.privateKey, debug = 0 } = {}) {
 const hostNonce=randomBytes(32),credential=randomBytes(32),statement=Buffer.from('{}');
 const bound=hvNodeBinding(world.transport.spki,hostNonce,statement);
 const L=buildLog({idksPub:world.idks.publicKey,...boot});
 const Q=buildQuote({aikPriv:world.aik.privateKey,aikName:world.aik.name,pcrs:L.pcrs,pcr0:world.pcr0,extraData:sha(bound)});
 const evidence={statement:b64(statement),signature:b64(sign(null,bound,world.transport.privateKey)),log:b64(L.log),
  quote:{attest:b64(Q.attest),sig:b64(Q.sig),aikPub:b64(world.aik.tpmtPublic)},credential:b64(credential),
  ek:{cert:b64(world.ek.cert),chain:[b64(world.ca.inter)]},pcr0:world.pcr0.toString('hex')};
 const handshakeSpki=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}),nonce=randomBytes(32),rid=runtimeId(runtime);
 const input=Buffer.concat([bind2(handshakeSpki,nonce,rid),Buffer.from(app,'hex')]);
 const claims=Buffer.from(JSON.stringify({'user-data':input.toString('hex')})),env=Buffer.alloc(1236+claims.length);
 const w=(o,n)=>env.writeUInt32LE(n,o);
 w(0,0x414c4348);w(4,2);w(8,env.length);w(12,2);w(1216,20+claims.length);w(1220,1);w(1224,1);w(1228,1);w(1232,claims.length);claims.copy(env,1236);
 const r=env.subarray(32,592);[560,1,1,256,0,2].forEach((n,i)=>r.writeUInt32LE(n,i*4));sha(claims).copy(r,24);Buffer.from(image,'hex').copy(r,120);r.writeUInt32LE(5,216);r.writeUInt32LE(debug,220);r.writeUInt32LE(2,224);
 sign('sha256',r.subarray(0,304),{key:signer,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).copy(r,304);
 return {doc:{abi:ABI2,nonce:nonce.toString('hex'),transportKey:b64(handshakeSpki),appSha256:app,runtime,report:b64(Buffer.from(JSON.stringify({vbsVmReport:b64(env)})))},handshakeSpki,nonce,
  expectedAppSha256:app,expectedRuntimeId:rid.toString('hex'),hostSession:{evidence,nonce:hostNonce,transportKeySpki:world.transport.spki,expectedCredential:credential,mintedFor:{ekCert:world.ek.cert,aikName:world.aik.name}}};
}
const run = (input, policy = {}) => verifyVbsAppEvidence(input,{ekRoots:world.ca.bundlePem,allowedMeasurements:[image],...policy});
const options={skip:!haveOpenssl && 'openssl absent'};
test('verifies app evidence through a complete authenticated boot chain',options,()=>{
 const r=run(fixture());assert.equal(r.ok,true,r.reason);assert.equal(r.measurement,image);assert.equal(r.appSha256,app);assert.equal(r.admissible,undefined);
});
test('rejects changed app, key, runtime and either fresh nonce',options,()=>{
 const f=fixture();for(const patch of [{expectedAppSha256:'00'.repeat(32)},{expectedRuntimeId:'00'.repeat(32)},{nonce:randomBytes(32)},{handshakeSpki:Buffer.alloc(44)},
  {hostSession:{...f.hostSession,nonce:randomBytes(32)}},{hostSession:{...f.hostSession,expectedCredential:randomBytes(32)}},{hostSession:{...f.hostSession,capture:{quoteExtraData:randomBytes(32)}}}])assert.equal(run({...f,...patch}).ok,false);
});
test('rejects debug firmware, missing image/root pins and a report from another boot',options,()=>{
 assert.equal(run(fixture({debug:1})).ok,false);assert.equal(run(fixture(),{allowedMeasurements:[]}).ok,false);assert.equal(run(fixture(),{ekRoots:''}).ok,false);
 assert.equal(run(fixture({signer:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey})).ok,false);
 assert.equal(run(fixture({boot:{secureBoot:0}})).ok,false);
});
