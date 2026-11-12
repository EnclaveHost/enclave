import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import {probeGuest} from '../network/guest-probe.mjs';
import {reconcileApps} from '../network/reconcile-apps.mjs';
import {SNP_VM_FORMAT,SnpVmIngress,snpVmExpectation,snpVmRoute,snpVmRuntimeId,validSnpVmExpectation,verifySnpVmProof} from '../network/snp-vm-app.mjs';

// A whole-VM app (catalog runtime "sev-snp-vm") is admitted on its own front's report and routed to its loopback port.
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'snp-vm-app-'));
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const selfSigned=name=>{
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=guest.test','-addext','subjectAltName=DNS:guest.test','-days','1',
    '-keyout',path.join(dir,name+'.key'),'-out',path.join(dir,name+'.pem')],{stdio:'ignore'});
  return {key:fs.readFileSync(path.join(dir,name+'.key')),cert:fs.readFileSync(path.join(dir,name+'.pem'))};
};
// "issued" stands for the certificate the VM installed for its app name; "boot" for the one it serves before that
const issued=selfSigned('issued'),boot=selfSigned('boot');
tls.setDefaultCACertificates([...tls.getCACertificates('default'),issued.cert.toString()]);
const spkiOf=cert=>new X509Certificate(cert).publicKey.export({format:'der',type:'spki'});

const id='0x'+'5f'.repeat(32),appRef='catalog://0x'+'0f'.repeat(32)+'/4',MEAS='22'.repeat(48),ROOT='3d'.repeat(32);
const versionConfig=(over={})=>JSON.stringify({schema:'enclave-rpc-snp/1',runtime:'sev-snp-vm',snp:{measurements:{8:MEAS},vcpuType:'EPYC-v4'},image:{rootHash:ROOT},...over});
const expected={appRef,configCid:'{}',appSha256:ROOT,runtimeId:snpVmRuntimeId([MEAS]),measurements:[MEAS],snpVm:{port:18443}};

test('the expectation is read from the catalog version, and only from a whole-VM one',()=>{
  assert.deepEqual(snpVmExpectation(versionConfig()),{appSha256:ROOT,runtimeId:snpVmRuntimeId([MEAS]),measurements:[MEAS]});
  assert.equal(snpVmExpectation(JSON.stringify({runtime:'wasm'})),null);
  assert.equal(snpVmExpectation(''),null);
  assert.equal(snpVmExpectation('not json'),null);
  assert.throws(()=>snpVmExpectation(versionConfig({snp:{measurements:{8:MEAS,16:'33'.repeat(48)}}})),/exactly one vCPU count/);
  assert.throws(()=>snpVmExpectation(versionConfig({snp:{measurements:{8:'22'}}})),/launch measurements required/);
  assert.throws(()=>snpVmExpectation(versionConfig({image:{}})),/no image root hash/);
  // the identity names the set, not its order, and another set is another runtime
  const other='33'.repeat(48);
  assert.equal(snpVmRuntimeId([MEAS,other]),snpVmRuntimeId([other,MEAS]));
  assert.notEqual(snpVmRuntimeId([MEAS,other]),snpVmRuntimeId([MEAS]));
  assert.throws(()=>snpVmRuntimeId([MEAS,MEAS]),/launch measurements required/);
});

test('an expectation that names a whole-VM app is complete or refused',()=>{
  assert.equal(validSnpVmExpectation(expected),true);
  assert.equal(validSnpVmExpectation({...expected,snpVm:{port:443}}),false);
  assert.equal(validSnpVmExpectation({...expected,snpVm:{port:18443,host:'10.0.0.1'}}),false);
  assert.equal(validSnpVmExpectation({...expected,measurements:['33'.repeat(48)]}),false);
  assert.equal(validSnpVmExpectation({...expected,measurements:undefined}),false);
  assert.equal(validSnpVmExpectation({...expected,appSha256:undefined}),false);
});

// a report shaped like a real one: policy, report_data, measurement and HOST_DATA where the firmware puts them
const SPKI=spkiOf(issued.cert),NONCE=Buffer.alloc(32,7);
function report({hostData=id.slice(2),measurement=MEAS,spki=SPKI,nonce=NONCE}={}){
  const r=Buffer.alloc(0x4a0);
  r.writeUInt32LE(5,0x00);r.writeBigUInt64LE(0x30000n,0x08);
  createHash('sha256').update(Buffer.concat([spki,nonce])).digest().copy(r,0x50);
  Buffer.from(measurement,'hex').copy(r,0x90);Buffer.from(hostData,'hex').copy(r,0xc0);
  Buffer.from('0103020500000075','hex').copy(r,0x180);r[0x188]=0x1a;r[0x189]=0x02;r[0x18a]=1;
  return r;
}
const docFor=(r,extra={})=>({format:SNP_VM_FORMAT,report:r.toString('base64'),...extra});
const signed={ok:true,measurement:MEAS,vcekVerified:true,tcb:{checked:true},reasons:['reported TCB meets the supplied minimum']};
const FLOOR={Turin:{fmc:1,bootloader:3,tee:2,snp:5,microcode:117}};

test('a report is accepted only when AMD signed it, for a listed measurement, a judged TCB and this deployment',async()=>{
  const asked=[],verify=verdict=>async(r,opts)=>{asked.push({r,opts});return verdict;};
  const policy={deploymentId:id,expected,minTcb:FLOOR,vcek:Buffer.from('vcek')};
  assert.deepEqual(await verifySnpVmProof(docFor(report()),SPKI,NONCE,{...policy,verify:verify(signed)}),{ok:true,measurement:MEAS});
  const {opts}=asked[0];
  assert.deepEqual(opts.allowedMeasurements,[MEAS]);assert(opts.challenge.equals(NONCE));assert(opts.transportKeySpki.equals(SPKI));
  assert.equal(opts.kds,false,'the host holds its own VCEK: nothing is fetched for a probe');assert.deepEqual(opts.minTcb,FLOOR);
  assert(opts.auxblob.subarray(48).equals(Buffer.from('vcek')));
  const refused=async(doc,over,why)=>{const v=await verifySnpVmProof(doc,SPKI,NONCE,{...policy,verify:verify(signed),...over});assert.equal(v.ok,false);assert.match(v.reason,why);};
  await refused(docFor(report()),{verify:verify({ok:false,reasons:['measurement 2222… not on the Metal release allowlist']})},/not on the Metal release allowlist/);
  await refused(docFor(report()),{verify:verify({...signed,vcekVerified:false})},/signature chain or the minimum TCB/);
  await refused(docFor(report()),{verify:verify({...signed,tcb:{checked:false}})},/signature chain or the minimum TCB/);
  await refused(docFor(report({hostData:'aa'.repeat(32)})),{},/HOST_DATA is not this deployment/);
  await refused(docFor(report()),{expected:{...expected,runtimeId:'00'.repeat(32)}},/not the expected runtime/);
  await refused(docFor(report()),{minTcb:undefined},/no minimum-TCB policy/);
  await refused({format:SNP_VM_FORMAT},{},/no report/);
});

test('the default verifier refuses a report that carries everything but an AMD signature',async()=>{
  const policy={deploymentId:id,expected,minTcb:FLOOR};
  // right measurement, right binding, right deployment - and no VCEK to check the signature with
  let v=await verifySnpVmProof(docFor(report()),SPKI,NONCE,policy);
  assert.equal(v.ok,false);assert.match(v.reason,/no VCEK available/);
  v=await verifySnpVmProof(docFor(report({nonce:Buffer.alloc(32,8)})),SPKI,NONCE,policy);
  assert.equal(v.ok,false);assert.match(v.reason,/report_data does not bind/);
  v=await verifySnpVmProof(docFor(report({measurement:'33'.repeat(48)})),SPKI,NONCE,policy);
  assert.equal(v.ok,false);assert.match(v.reason,/not on the Metal release allowlist/);
});

// the VM's front, as the agent sees it
async function front(tlsOptions,{appSha256=ROOT,format=SNP_VM_FORMAT}={}){
  let reports=0;
  const server=https.createServer(tlsOptions,(req,res)=>{
    const u=new URL(req.url,'https://guest.test');
    if(u.pathname==='/.well-known/enclave-ready'){res.writeHead(200);res.end('ok');return;}
    reports++;
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({format,nonce:u.searchParams.get('nonce'),transportKey:spkiOf(tlsOptions.cert).toString('base64'),appSha256,report:'AAAA'}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const {port}=server.address(),ingress=new SnpVmIngress({expected:()=>({...expected,snpVm:{port}})});
  return {port,reports:()=>reports,close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);}),
    probe:(extra={})=>probeGuest({deploymentId:id,hostname:'guest.test',expected,openApp:d=>ingress.open(d),snpVm:{minTcb:FLOOR},...extra})};
}

test('the agent admits a whole-VM app on its front\'s verified report, over the certificate it serves for its name',{timeout:60000},async()=>{
  const g=await front(issued),seen=[];
  try{
    const r=await g.probe({verifySnpVm:async(doc,spki,nonce,policy)=>{seen.push({doc,spki,nonce,policy});return {ok:true};}});
    assert.deepEqual(r,{ready:true,verified:true,deploymentId:id,appSha256:ROOT,runtimeId:expected.runtimeId,spkiSha256:createHash('sha256').update(SPKI).digest('hex')});
    assert.equal(seen.length,1);assert(seen[0].spki.equals(SPKI));assert.equal(seen[0].doc.nonce,seen[0].nonce.toString('hex'));
    assert.equal(seen[0].policy.deploymentId,id);assert.deepEqual(seen[0].policy.expected,expected);assert.deepEqual(seen[0].policy.minTcb,FLOOR);
    await assert.rejects(g.probe({verifySnpVm:async()=>({ok:false,reason:'HOST_DATA is not this deployment'})}),/whole-VM guest proof refused: HOST_DATA is not this deployment/);
    // the real verifier, given the front's placeholder report
    await assert.rejects(g.probe(),/whole-VM guest proof refused/);
    // no whole-VM policy: the format is not one any other policy vouches for
    await assert.rejects(g.probe({snpVm:undefined,linux:{runtime:{}}}),/no independently trusted guest verification policy/);
  }finally{await g.close();}
});

test('a front for another image, or one still on its boot certificate, is not admitted',{timeout:60000},async()=>{
  const never=async()=>{throw new Error('must not be asked');};
  let g=await front(issued,{appSha256:'aa'.repeat(32)});
  try{await assert.rejects(g.probe({verifySnpVm:never}),/app, nonce or TLS binding mismatch/);}finally{await g.close();}
  g=await front(boot);
  try{await assert.rejects(g.probe({verifySnpVm:never}),/self.signed certificate/);assert.equal(g.reports(),0);}finally{await g.close();}
});

test('connections go to the port the expectation names, and nowhere without one',{timeout:60000},async()=>{
  const echo=net.createServer(s=>s.on('data',b=>s.write(Buffer.from(b.toString().toUpperCase()))));
  await new Promise(r=>echo.listen(0,'127.0.0.1',r));
  const {port}=echo.address(),other='0x'+'ab'.repeat(32);
  const ingress=new SnpVmIngress({expected:d=>d===id?{...expected,snpVm:{port}}:d===other?{appSha256:ROOT}:undefined});
  try{
    assert.equal(ingress.handles(id),true);assert.equal(ingress.handles(other),false);assert.equal(ingress.handles('0x'+'cd'.repeat(32)),false);
    await assert.rejects(ingress.open(other),/unknown whole-VM deployment/);
    await assert.rejects(ingress.open('5f'.repeat(32)),/unknown whole-VM deployment/);
    // forward: the caller's bytes reach the VM and its answer comes back
    const relay=net.createServer(s=>void ingress.forward(s,id));
    await new Promise(r=>relay.listen(0,'127.0.0.1',r));
    const client=net.connect(relay.address().port,'127.0.0.1');
    const answer=await new Promise((resolve,reject)=>{client.once('data',resolve);client.once('error',reject);client.write('eth_chainid');});
    assert.equal(answer.toString(),'ETH_CHAINID');
    client.destroy();await new Promise(r=>relay.close(r));
  }finally{await new Promise(r=>echo.close(r));}
  await assert.rejects(new SnpVmIngress({expected:()=>({snpVm:{port}})}).open(id),/ECONNREFUSED/);
});

test('the manager\'s route record counts only for this deployment and the lease\'s version',()=>{
  const route={deploymentId:id,name:'5f5f5f5f.app.enclave.host',port:18443,appRef,measurements:[MEAS],rootHash:ROOT};
  assert.deepEqual(snpVmRoute(route,{deploymentId:id,appRef}),{port:18443});
  assert.equal(snpVmRoute(route,{deploymentId:id,appRef:appRef.replace(/4$/,'5')}),null);
  assert.equal(snpVmRoute(route,{deploymentId:'0x'+'ab'.repeat(32),appRef}),null);
  assert.equal(snpVmRoute({...route,port:'18443'},{deploymentId:id,appRef}),null);
  assert.equal(snpVmRoute(null,{deploymentId:id,appRef}),null);
});

test('the reconciler enrolls a whole-VM app from the chain once its VM serves a certificate',async()=>{
  const home=fs.mkdtempSync(path.join(dir,'host-')),configFile=path.join(home,'config.json'),pinFile=path.join(home,'pins.json');
  const guestdRoot=path.join(home,'guests'),snpVmState=path.join(home,'snpvm');fs.mkdirSync(guestdRoot);fs.mkdirSync(snpVmState);
  const runner='0x'+'4d'.repeat(32),configCid=JSON.stringify({snpVm:{app:'enclave-rpc',measurementsFrom:appRef}});
  fs.writeFileSync(configFile,JSON.stringify({version:2,runner,chain:{},apps:[],enclaveNetwork:{}}));fs.writeFileSync(pinFile,'{}');
  let lease={id,appRef,configCid},reloaded=0;const lines=[];
  const versions={[appRef]:{cid:'bafy-r13',config:versionConfig()},[appRef.replace(/4$/,'5')]:{cid:'bafy-r14',config:versionConfig({image:{rootHash:'4e'.repeat(32)}})}};
  const opts={configFile,pinFile,guestdRoot,snapshotReader:async()=>({rows:[lease],versions,blockNumber:'1',hash:'0x00'}),reloadAgent:async()=>{reloaded++;},log:m=>lines.push(m)};
  const apps=()=>JSON.parse(fs.readFileSync(configFile)).apps;
  const route=over=>fs.writeFileSync(path.join(snpVmState,id+'.route.json'),JSON.stringify({deploymentId:id,port:18443,appRef,...over}));

  // the VM manager's state is not named, or the VM has no certificate yet: nothing is enrolled
  route({});
  assert.equal((await reconcileApps(opts)).changed,false);assert.match(lines.at(-2),/serves no certificate/);
  fs.rmSync(path.join(snpVmState,id+'.route.json'));
  assert.equal((await reconcileApps({...opts,snpVmState})).changed,false);assert.deepEqual(apps(),[]);
  // a record for another version of the app is not this lease's
  route({appRef:appRef.replace(/4$/,'3')});
  assert.equal((await reconcileApps({...opts,snpVmState})).changed,false);assert.deepEqual(apps(),[]);assert.equal(reloaded,0);

  route({});
  assert.equal((await reconcileApps({...opts,snpVmState})).changed,true);assert.equal(reloaded,1);
  const [app]=apps();
  assert.deepEqual(app.names,['5f5f5f5f.app.enclave.host']);assert.equal(app.publishToMirror,false);
  // image and measurements are the catalog version's; the manager supplied the port and nothing else
  assert.deepEqual(JSON.parse(fs.readFileSync(app.expectedFile)),{appRef,configCid,appSha256:ROOT,runtimeId:snpVmRuntimeId([MEAS]),measurements:[MEAS],snpVm:{port:18443}});
  assert.equal(validSnpVmExpectation(JSON.parse(fs.readFileSync(app.expectedFile))),true);
  assert.equal((await reconcileApps({...opts,snpVmState})).changed,false);assert.equal(reloaded,1);

  // the owner moves the lease to another version: the old VM's record does not carry over, and the new one's does
  const next=appRef.replace(/4$/,'5');lease={id,appRef:next,configCid};
  assert.equal((await reconcileApps({...opts,snpVmState})).changed,false);
  assert.equal(JSON.parse(fs.readFileSync(app.expectedFile)).appRef,appRef);
  route({appRef:next,port:18444});
  assert.equal((await reconcileApps({...opts,snpVmState})).changed,true);assert.equal(reloaded,2);
  const moved=JSON.parse(fs.readFileSync(app.expectedFile));
  assert.equal(moved.appRef,next);assert.equal(moved.appSha256,'4e'.repeat(32));assert.deepEqual(moved.snpVm,{port:18444});

  // a version that publishes no usable measurement is refused, not guessed
  versions[next].config=versionConfig({snp:{measurements:{}}});
  assert.equal((await reconcileApps({...opts,snpVmState})).changed,false);assert(lines.some(l=>/whole-VM version refused/.test(l)));
});
