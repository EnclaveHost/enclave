import test from 'node:test';
import assert from 'node:assert/strict';
import {LeaseReader,AdmissionGate} from '../network/lease-reader.mjs';
const id='0x'+'ab'.repeat(32),runner='0x'+'cd'.repeat(32),book='0x'+'01'.repeat(20),contract='0x'+'02'.repeat(20);
const now=()=>1700000000000;
const row={id,runner,owner:book,runnerOperator:book,active:true,isPublic:true,leaseUntil:1700003600n,appRef:'catalog:a:1',configCid:''};
function client({time=1699999995n,hash='0x'+'aa'.repeat(32),value=row,fail=false}={}) {return {
 getChainId:async()=>{if(fail)throw Error('offline');return 8453},getBlockNumber:async()=>1000n,
 getBlock:async()=>({hash,timestamp:time}),readContract:async({functionName})=>functionName==='addr'?contract:functionName==='deploymentsSchema'?15n:value,
};}
test('only an agreeing recent chain quorum can renew authorization',async()=>{
 const reader=new LeaseReader({addressBook:book,clients:[client(),client()],now});
 const [lease]=await reader.refresh([id]);assert.equal(lease.validUntil,1699999995000+90000);
 reader.clients=[client(),client({value:{...row,runner:'0x'+'de'.repeat(32)}})];
 await assert.rejects(reader.refresh([id]),/agreeing chain quorum/);
 assert.equal(reader.get(id).validUntil,lease.validUntil);
 reader.clients=[client({time:1699999800n}),client({time:1699999800n})];
 await assert.rejects(reader.refresh([id]),/fresh agreeing/);
 reader.clients=[client(),client({fail:true})];await assert.rejects(reader.refresh([id]),/quorum unavailable/);
 reader.now=()=>lease.validUntil;assert.equal(reader.get(id),null);
});
test('a stale outlier cannot prevent two fresh peers from agreeing',async()=>{
 const reader=new LeaseReader({addressBook:book,clients:[client({time:1699999800n}),client(),client()],now});
 assert.equal((await reader.refresh([id]))[0].runner,runner);
});
test('guest proof expires without self-extension and lease changes invalidate it',async()=>{
 let clock=now();const expected={appRef:row.appRef,configCid:'',appSha256:'ab'.repeat(32),runtimeId:'cd'.repeat(32)};
 const gate=new AdmissionGate({runner,expected:()=>expected,now:()=>clock});
 const lease={...row,leaseUntil:clock+300000,validUntil:clock+90000};gate.observeLease(lease);
 const verify=async()=>({verified:true,deploymentId:id,appSha256:expected.appSha256,runtimeId:expected.runtimeId,spkiSha256:'ef'.repeat(32)});
 await gate.attest(id,verify);assert.equal(gate.allows(id),true);
 clock+=60000;gate.observeLease({...lease,validUntil:clock+90000});assert.equal(gate.allows(id),false);
 await gate.attest(id,verify);assert.equal(gate.allows(id),true);
 gate.observeLease({...lease,appRef:'catalog:a:2',validUntil:clock+90000});assert.equal(gate.allows(id),false);
 await assert.rejects(gate.attest(id,verify),/expectation/);
});
