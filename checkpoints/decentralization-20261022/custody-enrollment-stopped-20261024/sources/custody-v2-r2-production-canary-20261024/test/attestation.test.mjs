// Offline SNP-adapter tests: real report parser/binding, synthetic reports and a deliberately injected fake AMD verifier.
// No fixture is AMD-signed and these tests do not constitute hardware verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {attestR2Custodian,checkR2Manifest,MAX_EVIDENCE_BYTES} from '../driver/attestation.mjs';
import {R2,METAL0_REGISTRY_ID} from '../driver/plan.mjs';
const root='/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023';
const real=await import(pathToFileURL(root+'/repo-r2/relay/snp-verify.mjs').href);
const {machineBinding}=await import(pathToFileURL(root+'/repo-r2/custody/v2/member.mjs').href);
const {DEFAULT_MIN_TCB}=await import(pathToFileURL(root+'/repo-r2/custody/rules.mjs').href);
const manifestBytes=fs.readFileSync(root+'/out-r2/A-custodian/manifest.json');
const sha=x=>createHash('sha256').update(x).digest('hex');
const endpoint='https://custody-canary.enclave.host',H=x=>'0x'+x.repeat(32);
function rig(change=()=>{}) {
 const s={time:1000000,calls:[],nonces:[],verifications:0};
 const machine={identity:'0x'+'12'.repeat(20),encKey:H('34'),endpoint,chipId:'0x'+sha(Buffer.alloc(64,42)),registryId:METAL0_REGISTRY_ID,measurement:R2.measurementSha256};
 const make=nonce=>{
  const report=Buffer.alloc(1184);report.writeUInt32LE(3,0);Buffer.from(R2.measurement,'hex').copy(report,0x90);Buffer.alloc(64,42).copy(report,0x1a0);
  Buffer.from(machineBinding(machine,Buffer.from(nonce,'hex'))).copy(report,0x50);
  return {machine:{...machine},hostSig:'0x'+'00'.repeat(65),report:report.toString('base64'),auxblob:null,receipts:[]};
 };
 const opts={endpoint,manifestBytes,bindingOf:machineBinding,now:()=>s.time,
  fetchImpl:async(url,opt)=>{
   s.calls.push({url,opt});const nonce=JSON.parse(opt.body).nonce;s.nonces.push(nonce);const ev=make(nonce);change(ev,s);
   return new Response(JSON.stringify(ev),{headers:{'content-type':'application/json'}});
  },verifier:{...real,verifyQuote:async(report,opt)=>{
   s.verifications++;assert.equal(opt.requireVcek,true);assert.equal(opt.expectedVmpl,0);assert.deepEqual(opt.allowedMeasurements,[R2.measurement]);assert.deepEqual(opt.minTcb,DEFAULT_MIN_TCB);
   const bound=real.parseSnpReport(report).reportData.subarray(0,32).equals(opt.expectedBinding);
   return {ok:bound,vcekVerified:true,vmpl:0,measurement:R2.measurement,tcb:{checked:true}};
  }}};
 return {s,opts,machine};
}
test('fresh independent challenges, pinned AMD verification options, private machine and minimal public evidence',async()=>{
 const {s,opts,machine}=rig();const a=await attestR2Custodian(opts),b=await attestR2Custodian(opts);
 assert.deepEqual(a.machine,machine);assert.notEqual(s.nonces[0],s.nonces[1]);assert.notEqual(a.publicEvidence.challengeSha256,b.publicEvidence.challengeSha256);
 assert.equal(a.publicEvidence.vcekVerified,true);assert.equal(a.publicEvidence.minimumTcbChecked,true);
 assert.equal(s.calls[0].url,endpoint+'/v2/custody/evidence');assert.equal(s.calls[0].opt.redirect,'error');assert.equal(s.calls[0].opt.cache,'no-store');
 assert.deepEqual(Object.keys(JSON.parse(s.calls[0].opt.body)),['nonce']);
 const publicText=JSON.stringify(a.publicEvidence);assert.ok(!publicText.includes(machine.chipId));assert.ok(!publicText.includes('00'.repeat(65)));assert.ok(!publicText.includes('auxblob'));
 assert.equal(Object.isFrozen(a.machine),true);
});
test('rejects unreviewed manifest and wrong origin, host, identity or code before quote verification',async()=>{
 assert.equal(checkR2Manifest(manifestBytes).commit,R2.commit);
 assert.throws(()=>checkR2Manifest(Buffer.concat([manifestBytes,Buffer.from('\n')])),/reviewed/);
 for(const change of [m=>m.endpoint='https://other.example',m=>m.registryId=H('ab'),m=>m.measurement=H('ab'),m=>m.identity='0x'+'00'.repeat(20),m=>m.extra=true]){
  const r=rig(ev=>change(ev.machine));await assert.rejects(attestR2Custodian(r.opts),/refused/);assert.equal(r.s.verifications,0);
 }
 const r=rig();await assert.rejects(attestR2Custodian({...r.opts,endpoint:'http://localhost'}),/HTTPS/);assert.equal(r.s.calls.length,0);
});
test('rejects an old challenge and a chip identity not proved by the signed report',async()=>{
 const old=rig(ev=>{const b=Buffer.from(ev.report,'base64');b.fill(0,0x50,0x70);ev.report=b.toString('base64');});
 await assert.rejects(attestR2Custodian(old.opts),/verification failed/);
 const mismatch=rig(ev=>{ev.machine.chipId=H('ab');const b=Buffer.from(ev.report,'base64');Buffer.from(machineBinding(ev.machine,Buffer.from(mismatch.s.nonces.at(-1),'hex'))).copy(b,0x50);ev.report=b.toString('base64');});
 await assert.rejects(attestR2Custodian(mismatch.opts),/physical chip/);
 const masked=rig(ev=>{const b=Buffer.from(ev.report,'base64');b.fill(0,0x1a0,0x1e0);ev.report=b.toString('base64');});
 await assert.rejects(attestR2Custodian(masked.opts),/physical chip/);
});
test('requires verified VCEK, checked firmware floor, measurement and VMPL even if verifier returns ok',async()=>{
 for(const patch of [{vcekVerified:false},{tcb:{checked:false}},{measurement:'ab'.repeat(48)},{vmpl:1},{ok:false}]){
  const r=rig(),base=r.opts.verifier.verifyQuote;r.opts.verifier.verifyQuote=async(...args)=>({...await base(...args),...patch});
  await assert.rejects(attestR2Custodian(r.opts),/verification failed/);
 }
});
test('debug, migration-agent and lower privilege reports are rejected independently of verifier flags',async()=>{
 for(const change of [b=>b.writeBigUInt64LE(1n<<19n,8),b=>b.writeBigUInt64LE(1n<<18n,8),b=>b.writeUInt32LE(1,0x30)]){
  const r=rig(ev=>{const b=Buffer.from(ev.report,'base64');change(b);ev.report=b.toString('base64');});
  await assert.rejects(attestR2Custodian(r.opts),/policy or privilege/);
 }
});
test('rejects stale verification, malformed or oversized evidence and transport errors without echoing peer payloads',async()=>{
 const slow=rig((ev,s)=>s.time+=120001);await assert.rejects(attestR2Custodian(slow.opts),/freshness/);
 for(const body of ['private peer error',' '.repeat(MAX_EVIDENCE_BYTES+1),JSON.stringify({machine:rig().machine,report:'!bad!'})]){
  const r=rig();r.opts.fetchImpl=async()=>new Response(body,{headers:{'content-type':'application/json'}});
  await assert.rejects(attestR2Custodian(r.opts),e=>!e.message.includes('private peer error'));
 }
 const r=rig();r.opts.verifier.verifyQuote=async()=>{throw Error('custodian attestation refused: private peer error');};
 await assert.rejects(attestR2Custodian(r.opts),e=>e.message==='custodian attestation refused: evidence transport or verifier failed');
});
test('refuses redirects, HTTP errors and over-limit declared lengths',async()=>{
 for(const response of [new Response('{}',{status:503}),new Response('{}',{status:302}),new Response('{}',{headers:{'content-type':'text/html'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':String(MAX_EVIDENCE_BYTES+1)}})]){
  const r=rig();r.opts.fetchImpl=async()=>response;await assert.rejects(attestR2Custodian(r.opts),/refused/);assert.equal(r.s.verifications,0);
 }
});
