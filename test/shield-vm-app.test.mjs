// A whole-VM app on an Enclave Shield host: the same image and front as on SEV-SNP, judged by this platform's report
// (network/shield-vm-app.mjs) against the launch identities its catalog version lists for the platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {randomBytes,createHash,sign,constants,generateKeyPairSync,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import tls from 'node:tls';
import {hvNodeBinding} from '../relay/hvnode-verify.mjs';
import {rsaKeyFromModulus} from '../relay/vbs-verify.mjs';
import {parseTcgLog,vsmKey} from '../relay/vbs-tcglog.mjs';
import {haveOpenssl,tmpdir,makeVbsWorld,buildLog,buildQuote} from './fixtures/vbs-synthetic.mjs';
import {SHIELD_VM_FORMAT,judgeShieldVmReport,shieldVmUserData,verifyShieldVmProof} from '../network/shield-vm-app.mjs';
import {SNP_VM_FORMAT,SnpVmIngress,snpVmExpectation,snpVmRuntimeId,validSnpVmExpectation,validShieldLaunch,verifySnpVmProof,wholeVmRuntimeId} from '../network/snp-vm-app.mjs';
import {probeGuest} from '../network/guest-probe.mjs';
import {shieldVerifier,composeVerifier} from '../cli/connect.mjs';

const sha=b=>createHash('sha256').update(b).digest(),b64=b=>b.toString('base64');
const dir=haveOpenssl?tmpdir('shield-vm-'):null,world=haveOpenssl?makeVbsWorld(dir):null;
test.after(()=>{if(dir)fs.rmSync(dir,{recursive:true,force:true});});
const options={skip:!haveOpenssl&&'openssl absent'};
const id='0x'+'5f'.repeat(32),other='0x'+'6a'.repeat(32),ROOT='3d'.repeat(32),MEAS='22'.repeat(48),DIGEST='ab'.repeat(32),SVN=3;
const identity={signer:'91'.repeat(32),productId:1818455653,moduleId:1734437220};
const config=(over={})=>JSON.stringify({runtime:'sev-snp-vm',image:{rootHash:ROOT},snp:{measurements:{8:MEAS},vcpuType:'EPYC-v4'},shield:{launch:[{bootDigest:DIGEST,guestSvn:SVN}]},...over});
const expected=haveOpenssl?snpVmExpectation(config()):null;

// the paravisor's HCLA envelope around a VBS VM report over these 64 bytes, as the front's Shield source reads it
function envelope(userData,{signer=world.idks.privateKey,digest=DIGEST,svn=SVN,debug=0,signerId=identity}={}){
  const claims=Buffer.from(JSON.stringify({'user-data':userData.toString('hex')})),env=Buffer.alloc(1236+claims.length),w=(o,n)=>env.writeUInt32LE(n,o);
  w(0,0x414c4348);w(4,2);w(8,env.length);w(12,2);w(1216,20+claims.length);w(1220,1);w(1224,1);w(1228,1);w(1232,claims.length);claims.copy(env,1236);
  const r=env.subarray(32,592);[560,1,1,256,0,2].forEach((n,i)=>r.writeUInt32LE(n,i*4));sha(claims).copy(r,24);Buffer.from(digest,'hex').copy(r,120);
  Buffer.from(signerId.signer,'hex').copy(r,152);r.writeUInt32LE(5,216);r.writeUInt32LE(debug,220);r.writeUInt32LE(2,224);r.writeUInt32LE(svn,228);
  r.writeUInt32LE(signerId.productId,232);r.writeUInt32LE(signerId.moduleId,236);
  sign('sha256',r.subarray(0,304),{key:signer,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).copy(r,304);
  return env;
}
// the front's fresh document for this key and nonce, from a guest launched for `deployment`
const docFor=(spki,nonce,{deployment=id,...report}={})=>({format:SHIELD_VM_FORMAT,platform:'shield',nonce:nonce.toString('hex'),transportKey:b64(spki),appSha256:ROOT,
  report:b64(envelope(shieldVmUserData(spki,nonce,deployment),report)),measurement:'',hostData:deployment.slice(2)});
// this host's authenticated boot session, as the agent holds it
function session(boot={}){
  const hostNonce=randomBytes(32),credential=randomBytes(32),statement=Buffer.from('{}'),bound=hvNodeBinding(world.transport.spki,hostNonce,statement);
  const L=buildLog({idksPub:world.idks.publicKey,...boot}),Q=buildQuote({aikPriv:world.aik.privateKey,aikName:world.aik.name,pcrs:L.pcrs,pcr0:world.pcr0,extraData:sha(bound)});
  return {evidence:{statement:b64(statement),signature:b64(sign(null,bound,world.transport.privateKey)),log:b64(L.log),quote:{attest:b64(Q.attest),sig:b64(Q.sig),aikPub:b64(world.aik.tpmtPublic)},
    credential:b64(credential),ek:{cert:b64(world.ek.cert),chain:[b64(world.ca.inter)]},pcr0:world.pcr0.toString('hex')},nonce:hostNonce,transportKeySpki:world.transport.spki,
    expectedCredential:credential,mintedFor:{ekCert:world.ek.cert,aikName:world.aik.name}};
}
const policy=()=>({ekRoots:world.ca.bundlePem,platforms:[{ekCertSha256:sha(world.ek.cert).toString('hex'),pcr0:world.pcr0.toString('hex')}]});
const key=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'});

test('a version lists one root image and a launch identity per platform',()=>{
  const both=snpVmExpectation(config());
  assert.deepEqual(both,{appSha256:ROOT,runtimeId:wholeVmRuntimeId({measurements:[MEAS],shield:[{bootDigest:DIGEST,guestSvn:SVN}]}),measurements:[MEAS],shield:[{bootDigest:DIGEST,guestSvn:SVN}]});
  // SEV-SNP alone reads exactly as it did: the identity hosts and clients hold for today's versions is unchanged
  const snp=snpVmExpectation(config({shield:undefined}));
  assert.deepEqual(snp,{appSha256:ROOT,runtimeId:snpVmRuntimeId([MEAS]),measurements:[MEAS]});
  assert.notEqual(both.runtimeId,snp.runtimeId);
  // Shield alone
  const only=snpVmExpectation(config({snp:undefined}));
  assert.deepEqual(only.measurements,[]);assert.equal(only.appSha256,ROOT);assert.equal(only.runtimeId,wholeVmRuntimeId({measurements:[],shield:only.shield}));
  assert.notEqual(only.runtimeId,both.runtimeId);
  // every listed identity is part of the runtime: another digest, SVN or signer is another runtime
  const rid=l=>wholeVmRuntimeId({measurements:[MEAS],shield:l});
  assert.notEqual(rid([{bootDigest:DIGEST,guestSvn:SVN+1}]),both.runtimeId);
  assert.notEqual(rid([{bootDigest:DIGEST,guestSvn:SVN,identity}]),both.runtimeId);
  assert.equal(rid([{bootDigest:DIGEST,guestSvn:SVN},{bootDigest:'cd'.repeat(32),guestSvn:1}]),rid([{bootDigest:'cd'.repeat(32),guestSvn:1},{bootDigest:DIGEST,guestSvn:SVN}]));
  // a platform section that is present is complete, and a version lists at least one platform
  for(const shield of [{},{launch:[]},{launch:[{bootDigest:DIGEST}]},{launch:[{bootDigest:DIGEST.toUpperCase(),guestSvn:1}]},{launch:[{bootDigest:DIGEST,guestSvn:-1}]},
    {launch:[{bootDigest:DIGEST,guestSvn:1},{bootDigest:DIGEST,guestSvn:2}]},{launch:[{bootDigest:DIGEST,guestSvn:1,extra:1}]},{launch:[{bootDigest:DIGEST,guestSvn:1,identity:{signer:'00'.repeat(32),productId:1,moduleId:1}}]},
    {launch:[{bootDigest:DIGEST,guestSvn:1}],more:1},null])
    assert.throws(()=>snpVmExpectation(config({shield})),/Enclave Shield launch identities/,JSON.stringify(shield));
  assert.throws(()=>snpVmExpectation(config({snp:undefined,shield:undefined})),/by vCPU count/);
  assert.throws(()=>snpVmExpectation(config({snp:{measurements:{}}})),/by vCPU count/);
  assert.throws(()=>snpVmExpectation(config({snp:{measurements:{8:'22'}}})),/launch measurements required/);
  assert.equal(validShieldLaunch([{bootDigest:DIGEST,guestSvn:SVN,identity}]),true);
  // an expectation is whole on either platform or refused
  assert.equal(validSnpVmExpectation({...both,snpVm:{port:18443}}),true);
  assert.equal(validSnpVmExpectation({...only,snpVm:{port:18443}}),true);
  assert.equal(validSnpVmExpectation({...both,shield:[{bootDigest:'cd'.repeat(32),guestSvn:SVN}],snpVm:{port:18443}}),false);
  assert.equal(validSnpVmExpectation({...both,shield:undefined,snpVm:{port:18443}}),false);
});

test('the config the image tool writes for both wrappers is the one the agent reads',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'vm-version-')),app={rootHash:ROOT},common={schema:'enclave-vm-image/1',rootHash:ROOT,app,appJsonSha256:'cd'.repeat(32)};
  try{
    fs.writeFileSync(path.join(d,'snp.json'),JSON.stringify({...common,platform:'sev-snp',cmdline:'console=ttyS0 panic=-1'}));
    fs.writeFileSync(path.join(d,'shield.json'),JSON.stringify({...common,platform:'shield',cmdline:'console=ttyS0 loglevel=3 panic=-1',launchIdentity:{vbsBootDigest:DIGEST,guestSvn:SVN}}));
    fs.writeFileSync(path.join(d,'ovmf'),'firmware');
    const env={...process.env};delete env.PYTHONHOME;delete env.PYTHONPATH;
    const out=execFileSync('python3',['-I',new URL('../isolation/vmboot/version_config.py',import.meta.url).pathname,path.join(d,'snp.json'),path.join(d,'shield.json'),'--snp','8='+MEAS,'--ovmf',path.join(d,'ovmf'),'--vcpu-type','EPYC-v4'],{env,encoding:'utf8'});
    assert.deepEqual(snpVmExpectation(out),snpVmExpectation(config()));
    assert.equal(JSON.parse(out).image.cmdlineSha256,createHash('sha256').update('console=ttyS0 panic=-1').digest('hex'));
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('an SEV-SNP report is never judged against a version that lists no SEV-SNP boot',async()=>{
  const only=snpVmExpectation(config({snp:undefined}));
  const v=await verifySnpVmProof({format:SNP_VM_FORMAT,report:'AAAA'},Buffer.alloc(91,1),Buffer.alloc(32,2),{deploymentId:id,expected:only,minTcb:{},verify:async()=>({ok:true,vcekVerified:true,tcb:{checked:true}})});
  assert.deepEqual(v,{ok:false,reason:'the version publishes no SEV-SNP launch measurement'});
});

test('the Shield report is accepted through the host\'s authenticated boot, for this key, nonce and deployment',options,()=>{
  const spki=key(),nonce=randomBytes(32),judge=(doc,over={},k=spki,n=nonce)=>verifyShieldVmProof(doc,k,n,{deploymentId:id,expected,hostSession:session(),policy:policy(),...over});
  assert.deepEqual(judge(docFor(spki,nonce)),{ok:true,measurement:DIGEST,guestSvn:SVN});
  assert.deepEqual(judge(docFor(spki,nonce,{svn:SVN+4})),{ok:true,measurement:DIGEST,guestSvn:SVN+4});
  const refused=(v,why)=>{assert.equal(v.ok,false);assert.match(v.reason,why);};
  // freshness and the key of this connection
  refused(judge(docFor(spki,nonce),{},spki,randomBytes(32)),/guest binding differs/);
  refused(judge(docFor(spki,nonce),{},key()),/guest binding differs/);
  // the deployment: a guest launched for another one, or for none, is not this deployment's
  refused(judge(docFor(spki,nonce,{deployment:other})),/guest binding differs/);
  refused(judge(docFor(spki,nonce,{deployment:'0x'+'00'.repeat(32)})),/guest binding differs/);
  refused(judge(docFor(spki,nonce),{deploymentId:other}),/guest binding differs/);
  refused(judge(docFor(spki,nonce,{deployment:'0x'+'00'.repeat(32)}),{deploymentId:'0x'+'00'.repeat(32)}),/named deployment/);
  // the image: only a boot digest the version lists, at its SVN or above, not debuggable
  refused(judge(docFor(spki,nonce,{digest:'cd'.repeat(32)})),/image measurement is not pinned/);
  refused(judge(docFor(spki,nonce,{svn:SVN-1})),/guest SVN below the version's/);
  refused(judge(docFor(spki,nonce,{debug:1})),/debug-enabled/);
  // the signature: this boot's IDKS, from the log the TPM quote covers, and only a boot that verifies
  refused(judge(docFor(spki,nonce,{signer:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey})),/signature failed/);
  refused(judge(docFor(spki,nonce),{hostSession:session({secureBoot:0})}),/host boot verification failed/);
  refused(judge(docFor(spki,nonce),{hostSession:undefined}),/complete authenticated host session/);
  refused(judge(docFor(spki,nonce),{hostSession:{...session(),capture:{}}}),/complete authenticated host session/);
  refused(judge(docFor(spki,nonce),{policy:{...policy(),ekRoots:''}}),/host boot verification failed/);
  // the operator's platform policy
  refused(judge(docFor(spki,nonce),{policy:{...policy(),platforms:[{ekCertSha256:'00'.repeat(32),pcr0:'00'.repeat(32)}]}}),/not admitted/);
  refused(judge(docFor(spki,nonce),{policy:{ekRoots:world.ca.bundlePem}}),/platform firmware pins/);
  assert.equal(judge(docFor(spki,nonce),{policy:{...policy(),platforms:'attested'}}).ok,true);
  // the expectation: a version with no Shield identity admits no Shield boot, and half an expectation is none
  refused(judge(docFor(spki,nonce),{expected:snpVmExpectation(config({shield:undefined}))}),/no Enclave Shield launch identity/);
  refused(judge(docFor(spki,nonce),{expected:{...expected,runtimeId:'00'.repeat(32)}}),/not the expected runtime/);
  refused(judge(docFor(spki,nonce),{expected:undefined}),/no Enclave Shield launch identity/);
  // the document: this format, a bounded report, nothing else
  refused(judge({...docFor(spki,nonce),format:SNP_VM_FORMAT}),/not a Shield whole-VM document/);
  refused(judge({...docFor(spki,nonce),report:undefined}),/no report/);
  refused(judge({...docFor(spki,nonce),report:'A'.repeat(12001)}),/no report/);
  const t=Buffer.from(docFor(spki,nonce).report,'base64');t[32+130]^=1;
  refused(judge({...docFor(spki,nonce),report:b64(t)}),/not pinned|signature failed/);
});

test('a version that pins its boot image\'s signer admits only that signer, and pins all or none',options,()=>{
  const spki=key(),nonce=randomBytes(32),withId=l=>{const e={measurements:[MEAS],shield:l};return {...e,appSha256:ROOT,runtimeId:wholeVmRuntimeId(e)};};
  const judge=(doc,exp)=>verifyShieldVmProof(doc,spki,nonce,{deploymentId:id,expected:exp,hostSession:session(),policy:policy()});
  const pinned=withId([{bootDigest:DIGEST,guestSvn:SVN,identity}]);
  assert.equal(judge(docFor(spki,nonce),pinned).ok,true);
  assert.match(judge(docFor(spki,nonce,{signerId:{...identity,signer:'92'.repeat(32)}}),pinned).reason,/identity is not pinned/);
  assert.match(judge(docFor(spki,nonce,{svn:SVN-1}),pinned).reason,/guest SVN below/);
  assert.match(judge(docFor(spki,nonce),withId([{bootDigest:DIGEST,guestSvn:SVN,identity},{bootDigest:'cd'.repeat(32),guestSvn:1}])).reason,/some Shield boot images and not others/);
});

// the VM's front on a Shield host, as the host's agent reaches it
const selfSigned=name=>{
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=guest.test','-addext','subjectAltName=DNS:guest.test','-days','1',
    '-keyout',path.join(dir,name+'.key'),'-out',path.join(dir,name+'.pem')],{stdio:'ignore'});
  return {key:fs.readFileSync(path.join(dir,name+'.key')),cert:fs.readFileSync(path.join(dir,name+'.pem'))};
};
async function front(tlsOptions,make){
  const spki=new X509Certificate(tlsOptions.cert).publicKey.export({format:'der',type:'spki'});
  const server=https.createServer(tlsOptions,(req,res)=>{
    const u=new URL(req.url,'https://guest.test');
    if(u.pathname==='/.well-known/enclave-ready'){res.writeHead(200);res.end('ok');return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(make(spki,Buffer.from(u.searchParams.get('nonce'),'hex'))));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const {port}=server.address(),exp={...expected,snpVm:{port}},ingress=new SnpVmIngress({expected:()=>exp});
  return {close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);}),
    probe:(extra={})=>probeGuest({deploymentId:id,hostname:'guest.test',expected:exp,openApp:d=>ingress.open(d),shieldVm:{},shield:policy(),hostSession:session(),...extra})};
}
test('the host\'s agent admits a whole-VM app on a Shield host on that report and no other',{...options,timeout:60000},async()=>{
  const issued=selfSigned('issued');tls.setDefaultCACertificates([...tls.getCACertificates('default'),issued.cert.toString()]);
  let g=await front(issued,(spki,nonce)=>docFor(spki,nonce));
  try{
    const r=await g.probe();
    assert.equal(r.verified,true);assert.equal(r.ready,true);assert.equal(r.appSha256,ROOT);assert.equal(r.runtimeId,expected.runtimeId);
    await assert.rejects(g.probe({hostSession:undefined}),/whole-VM guest proof refused: a complete authenticated host session/);
    await assert.rejects(g.probe({shield:undefined}),/whole-VM guest proof refused: explicit TPM identity/);
    // without the whole-VM policy the document is an ordinary Shield app's to judge, and it is not one
    await assert.rejects(g.probe({shieldVm:undefined}),/Shield guest proof refused/);
  }finally{await g.close();}
  g=await front(issued,(spki,nonce)=>docFor(spki,nonce,{deployment:other}));
  try{await assert.rejects(g.probe(),/whole-VM guest proof refused: guest binding differs/);}finally{await g.close();}
  // a whole-VM lease is never admitted on another kind of document, whatever else this host could vouch for
  g=await front(issued,(spki,nonce)=>({...docFor(spki,nonce),format:'hyperv-partition-domain/v1'}));
  try{await assert.rejects(g.probe(),/not a Shield whole-VM document/);}finally{await g.close();}
});

test('enclave connect judges a Shield whole-VM guest against the caller\'s launch identity, under the verified host\'s IDKS',options,async()=>{
  const spki=key(),nonce=randomBytes(32),k=vsmKey(parseTcgLog(buildLog({idksPub:world.idks.publicKey}).log).events,'IDKS');
  assert.ok(rsaKeyFromModulus(k.modulus,k.exponent));
  const launch=[{bootDigest:DIGEST,guestSvn:SVN}],e={measurements:[],shield:launch};
  const verdict=(doc,l=launch,dep=id)=>judgeShieldVmReport(doc,spki,nonce,{deploymentId:dep,expected:{...e,shield:l,runtimeId:wholeVmRuntimeId({measurements:[],shield:l})},idksPublicKey:rsaKeyFromModulus(k.modulus,k.exponent)});
  assert.deepEqual(verdict(docFor(spki,nonce)),{ok:true,measurement:DIGEST,guestSvn:SVN});
  assert.equal(verdict(docFor(spki,nonce),[{bootDigest:'cd'.repeat(32),guestSvn:SVN}]).ok,false);
  assert.equal(verdict(docFor(spki,nonce),launch,other).ok,false);
  // the verifier the CLI composes: a whole-VM document goes to the Shield verifier, and needs the launch identity
  const none=await composeVerifier({snp:null,shield:null})(docFor(spki,nonce),spki,nonce);
  assert.equal(none.ok,false);assert.equal(none.format,SHIELD_VM_FORMAT);assert.match(none.reason,/--shield/);
  const noLaunch=await shieldVerifier({name:'box',deployment:id,fetchImpl:async()=>{throw new Error('must not be asked');}})(docFor(spki,nonce),spki,nonce);
  assert.equal(noLaunch.ok,false);assert.match(noLaunch.reason,/--expect-shield/);
});
