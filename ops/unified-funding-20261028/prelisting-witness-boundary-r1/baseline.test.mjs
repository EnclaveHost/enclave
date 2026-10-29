// Behavioral audit of the ORIGINAL witness. Passing means the documented gap is reproduced,
// not that the implementation meets pre-listing requirements. No cryptographic proof is mocked as real.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWitness} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/availability/witness.mjs';
const hex=(n)=>'0x'+n.repeat(64);
function fixture({active=true,audit=null,units=64}={}) {
 const calls={attest:0,availability:0,audit:0,sign:0};
 const host={endpoint:'https://qualification-fixture.invalid',async attest(){calls.attest++;return {report:'TEST ONLY',binding:Buffer.alloc(32),evidence:'TEST mocked attestation'};},async availability(){calls.availability++;return {nodeGflops:units,cpuGflopsFree:units};}};
 const witness=createWitness({signer:{async signTypedData(){calls.sign++;return 'TEST-NOT-A-SIGNATURE';}},chainId:8453,contract:'0x'+'11'.repeat(20),
  readRegistry:async()=>({active,operator:'0x'+'22'.repeat(20),payoutWallet:'0x'+'33'.repeat(20),cpuPricePerSec6:64n}),
  verifyQuote:async()=>({ok:true,chipId:'aa'.repeat(64),measurement:hex('b')}),allowedMeasurements:[hex('b')],minTcb:{},
  lastAudit:async()=>{calls.audit++;return audit;},state:new Map(),now:()=>1000n,log:()=>{}});
 return {calls,run:()=>witness.round([host])};
}
test('baseline cannot qualify an unregistered candidate: refuses before test or attestation',async()=>{
 const f=fixture({active:false}); const out=await f.run();
 assert.equal(out.receipts.length,0);assert.match(out.refused[0].reason,/registry entry not active/);
 assert.deepEqual(f.calls,{attest:0,availability:0,audit:0,sign:0});
});
test('baseline reaches receipt signing when no successful capacity audit exists',async()=>{
 const f=fixture();const out=await f.run();assert.equal(out.receipts.length,1);assert.equal(f.calls.sign,1);
 assert.equal(out.receipts[0].payload.lastAuditJob,undefined);assert.equal(out.receipts[0].payload.trustMode,'operator-bootstrap');
});
test('baseline receipt units come from reported availability, not exercised capacity',async()=>{
 const f=fixture({units:2048,audit:{passed:true,atSec:999,job:'tiny-TEST-job',exercisedCpuUnits:1}});
 const out=await f.run();assert.equal(out.receipts[0].payload.units,'2048');assert.equal(out.receipts[0].payload.spareUnits,'2048');
});
test('baseline explicit latest failed audit does suppress receipt signing',async()=>{
 const f=fixture({audit:{passed:false}});const out=await f.run();assert.equal(out.receipts.length,0);assert.equal(f.calls.sign,0);
 assert.match(out.refused[0].reason,/most recent paid audit failed/);
});
