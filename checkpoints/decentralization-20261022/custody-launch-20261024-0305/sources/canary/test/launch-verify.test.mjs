import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyLaunch,loopbackEvidenceTransport} from '../driver/launch-verify.mjs';
import {R2,METAL0_REGISTRY_ID} from '../driver/plan.mjs';
import {REFUSAL_PROBES,INGRESS_SOURCE} from '../driver/launch-ingress.mjs';
function fixture(){
 let clock=1000000;const calls=[];
 const pins={custodian:{endpoint:'https://canary.example'}},digest='a'.repeat(64);
 const runtime={status:'runtime-verified',unit:'test',invocation:'b'.repeat(32),bundleDigest:digest,hostPid:100,guestPid:101,protectedServicesUnchanged:true,loopbackPortsVerified:true,memoryMaxMiB:5120,memorySwapMaxMiB:0,recipientReserveMiB:2048,memAvailableMiB:25000,protectedVmCount:4,at:clock};
 const ingress={endpoint:pins.custodian.endpoint,bindingDigest:'b'.repeat(64),sourceCommit:INGRESS_SOURCE.commit,at:clock,refusals:REFUSAL_PROBES.map(([method,path])=>({method,path,status:404}))};
 const host={outcome:'pass',evidence:{blockTimestamp:1000,registryId:METAL0_REGISTRY_ID,acceptedOwner:'admin',operator:'operator',payoutWallet:'admin',endpoint:'https://api.enclave.host/t/metal0',active:true,resolves:{'host.accepted':{ok:true}}}};
 const machine={identity:'0x'+'11'.repeat(20),encKey:'0x'+'22'.repeat(32),chipId:'0x'+'33'.repeat(32),endpoint:pins.custodian.endpoint,registryId:METAL0_REGISTRY_ID,measurement:R2.measurementSha256};
 function quote(challenge){return {requestedAt:clock,verifiedAt:clock,machine:{...machine},publicEvidence:{requestedAt:new Date(clock).toISOString(),verifiedAt:new Date(clock).toISOString(),endpoint:machine.endpoint,identity:machine.identity,encKey:machine.encKey,measurement:R2.measurement,measurementSha256:R2.measurementSha256,manifestSha256:R2.manifestSha256,challengeSha256:challenge.repeat(64),quoteSha256:'e'.repeat(64),vcekVerified:true,minimumTcbChecked:true,vmpl:0,debugAllowed:false,migrationAgentAllowed:false,unexpectedSecret:'must-never-be-emitted'}};}
 const local=quote('c'),publicQuote=quote('d');
 const f={pins,digest,runtime,ingress,host,local,publicQuote,calls,now:()=>clock,
  inspectRuntime:async()=>{calls.push('runtime');return structuredClone(runtime);},inspectIngress:async()=>{calls.push('ingress');return structuredClone(ingress);},readHost:async()=>{calls.push('host');return structuredClone(host);},
  attestLocal:async()=>{calls.push('local');return structuredClone(local);},attestPublic:async()=>{calls.push('public');return structuredClone(publicQuote);}};
 f.tick=n=>{clock+=n;};f.run=()=>verifyLaunch(f);return f;
}
test('combined gate binds public and local machines to unchanged runtime, ingress and current host authority',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.outcome,'pass');assert.deepEqual(f.calls,['runtime','ingress','host','local','public','host','ingress','runtime']);assert.equal(Object.keys(r.evidence.resolves).length,3);
 assert.equal(r.evidence.resolves['custodian.launched'].by,r.evidence.evidenceDigest);assert.match(r.evidence.scope,/Single-seat bootstrap/);
 const out=JSON.stringify(r);assert.ok(!out.includes(f.local.machine.chipId));assert.ok(!out.includes('must-never-be-emitted'));assert.ok(!out.includes('unexpectedSecret'));
});
test('local socket transport permits only the exact evidence POST and preserves public-origin input to the verifier',async()=>{
 const hits=[],endpoint='https://canary.example';const transport=loopbackEvidenceTransport({endpoint,port:18971,fetchImpl:async(u,o)=>{hits.push({u,o});return new Response('{}');}});
 const opts={method:'POST',redirect:'error',body:'{"nonce":"fixture"}',signal:new AbortController().signal};await transport(endpoint+'/v2/custody/evidence',opts);
 assert.equal(hits[0].u,'http://127.0.0.1:18971/v2/custody/evidence');assert.equal(hits[0].o.signal,opts.signal);assert.equal(hits[0].o.redirect,'error');
 for(const [url,o] of [[endpoint+'/state',opts],[endpoint+'/v2/custody/evidence?x=1',opts],[endpoint+'/v2/custody/evidence',{...opts,method:'GET'}],[endpoint+'/v2/custody/evidence',{...opts,redirect:'follow'}]])await assert.rejects(transport(url,o),/only evidence POST/);
 assert.equal(hits.length,1);assert.throws(()=>loopbackEvidenceTransport({endpoint,port:80}),/port invalid/);
});
test('different chip, key, identity, registry, origin or measurement between local and public evidence refuses',async()=>{
 for(const [k,v] of [['chipId','0x'+'44'.repeat(32)],['encKey','0x'+'44'.repeat(32)],['identity','0x'+'44'.repeat(20)],['registryId','0x'+'44'.repeat(32)],['endpoint','https://other.example'],['measurement','0x'+'44'.repeat(32)]]){
  const f=fixture();f.publicQuote.machine[k]=v;if(k in f.publicQuote.publicEvidence)f.publicQuote.publicEvidence[k]=v;await assert.rejects(f.run,/verification refused/);
 }
});
test('stale quotes, reused challenge, unsupported firmware, missing probe and weakened runtime refuse',async()=>{
 const changes=[f=>{f.local.requestedAt-=120001;},f=>{f.local.verifiedAt+=1;},f=>{f.publicQuote.publicEvidence.challengeSha256=f.local.publicEvidence.challengeSha256;},f=>{f.local.publicEvidence.minimumTcbChecked=false;},f=>{f.local.publicEvidence.vcekVerified=false;},f=>{f.local.publicEvidence.debugAllowed=true;},f=>{f.local.publicEvidence.manifestSha256='f'.repeat(64);},f=>{f.ingress.refusals.pop();},f=>{f.ingress.refusals[0].status=400;},f=>{f.runtime.memAvailableMiB=18000;},f=>{f.runtime.protectedServicesUnchanged=false;},f=>{f.host.evidence.resolves['host.accepted'].ok=false;}];
 for(const change of changes){const f=fixture();change(f);await assert.rejects(f.run,/verification refused/);}
});
test('authority, route or process changes during collection refuse and cannot manufacture a launch entry',async()=>{
 const changes=[f=>{f.host.evidence.acceptedOwner='new-owner';},f=>{f.ingress.bindingDigest='c'.repeat(64);},f=>{f.runtime.guestPid++;},f=>{f.runtime.invocation='c'.repeat(32);},f=>{f.tick(120001);f.runtime.at=f.now();f.ingress.at=f.now();f.host.evidence.blockTimestamp=Math.floor(f.now()/1000);}];
 for(const change of changes){const f=fixture(),old=f.attestPublic;f.attestPublic=async()=>{const q=await old();change(f);return q;};await assert.rejects(f.run,/verification refused/);}
 const f=fixture();f.attestLocal=async()=>{throw Error('private peer payload');};await assert.rejects(f.run,e=>e.message==='canary launch verification refused: live evidence collection failed');
});
