import test from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData } from 'viem';
import { chainFixture } from './helpers/chain-adapter-fixture.mjs';
import { transitionTypedData } from '../network/deployment-transition-intent.mjs';
import { loadSchema3Bundle, validateSchema3Bundle, schema3Emergency } from '../network/lifecycle-schema3-profile.mjs';
import { loadHostRegistryArtifact, validateHostRegistryArtifact } from '../network/lifecycle-host-registry-profile.mjs';

const prepare=async(f,target='running')=>f.adapter.prepare(f.id,await f.adapter.read(f.id),target,'test');

test('maintained artifact paths and same-block millisecond bridge contract: read, prepare and send',async()=>{
 const f=chainFixture(),s=await f.adapter.read(f.id);
 assert.equal(s.verified,true);assert.equal(s.admitted,true);assert.equal(s.blockAt,f.now);
 assert.equal(s.hostLifecycle.qualificationExpired,false);assert.equal(s.fundedUntil,Number.MAX_SAFE_INTEGER);
 assert.equal(s.hostAuthorityEvidence.context.owner,f.operator.address.toLowerCase());
 const intent=await prepare(f);await f.adapter.submit(f.id,intent);
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].maxFeePerGasWei,1000n);
 assert.ok(f.calls.length>30);assert.ok(f.calls.every(q=>q.blockNumber===f.number));
 assert.equal(f.adapter.independence.complete,false);
});

test('millisecond header identity must equal snapshot metadata; seconds, missing callback and mixed block refuse',async()=>{
 for(const mutate of [f=>f.headerOverride=h=>({...h,timestamp:BigInt(h.timestamp/1000)}),
  f=>f.resultOverride={timestamp:f.timestamp+1000},f=>f.resultOverride={blockHash:'0x'+'12'.repeat(32)},
  f=>f.resultOverride={blockNumber:f.number+1n}]){
  const f=chainFixture();mutate(f);await assert.rejects(f.adapter.read(f.id),/millisecond|differs/);assert.equal(f.sent.length,0);
 }
 const f=chainFixture(),a=f.create({authority:{kind:'derived',snapshot:async()=>({blockNumber:100n,blockHash:f.blockHash,timestamp:f.timestamp,value:{inner:{},adminChanges:[]}})}});
 await assert.rejects(a.read(f.id),/differs/);
});

test('unqualified RPC labels never acquire proof status or authorize preparation',async()=>{
 const f=chainFixture(),a=f.create({authority:{...f.authority,kind:'rpc-quorum'}}),s=await a.read(f.id);
 assert.equal(s.verified,false);assert.equal(s.hostAuthorityEvidence.proofVerified,false);
 await assert.rejects(a.prepare(f.id,s,'running','test'),/verified snapshot/);
 f.proof=false;const unqualified=await f.adapter.read(f.id);assert.equal(unqualified.verified,false);
});

test('reviewed pin configuration cannot be changed through retained caller objects',async()=>{
 const f=chainFixture(),intent=await prepare(f);f.pins.maxGasPriceWei='1';f.pins.maxChargeWei='1';f.pins.allowedMeasurements.length=0;
 assert.equal((await f.adapter.read(f.id)).admitted,true);await f.adapter.submit(f.id,intent);assert.equal(f.sent.length,1);
 const bad=chainFixture();bad.pins.contracts.accountingLibrary.codeHash='0x'+'ab'.repeat(32);assert.throws(()=>bad.create(),/codeHash/);
});

test('final Running boundary rejects changed wallet policy and original observation expiry after approval',async()=>{
 for(const change of [f=>f.hostRevision++,f=>{f.timestamp-=20000;},f=>{f.timestamp+=3000;},f=>{f.hostStatus=2;}]){
  const f=chainFixture(),intent=await prepare(f);f.onApprovals=()=>change(f);
  await assert.rejects(f.adapter.submit(f.id,intent),/final send guard/);assert.equal(f.sent.length,0);
 }
});

test('canonical Offline does not prevent owner queued/stopped requests',async()=>{
 for(const target of ['queued','stopped']){
  const f=chainFixture();f.hostStatus=2;const s=await f.adapter.read(f.id);assert.equal(s.admitted,false);
  const intent=await f.adapter.prepare(f.id,s,target,'owner');await f.adapter.submit(f.id,intent);assert.equal(f.sent.length,1);
 }
});

test('charge and fee caps survive canonical payload rewriting and signing delay',async()=>{
 const f=chainFixture(),intent=await prepare(f),p=JSON.parse(intent.payload);p.intent.maxChargeWei='101';
 const forged={payload:JSON.stringify(p),digest:hashTypedData(transitionTypedData({chainId:8453,lifecycle:f.pins.contracts.lifecycle.address},p.intent))};
 await assert.rejects(f.adapter.submit(f.id,forged),/charge exceeds/);
 f.maxGas=999n;await assert.rejects(f.adapter.submit(f.id,intent),/fee bound/);assert.equal(f.sent.length,0);
 const late=chainFixture(),stop=await prepare(late,'stopped');late.onSign=()=>{late.now+=91000;};
 await assert.rejects(late.adapter.submit(late.id,stop),/deadline passed during signing/);assert.equal(late.sent.length,0);
});

test('ambiguous send is propagated and state without the exact receipt remains unresolved',async()=>{
 const f=chainFixture(),intent=await prepare(f);f.loseResponse=true;
 await assert.rejects(f.adapter.submit(f.id,intent),/response lost/);assert.equal(f.sent.length,1);
 f.state=2;f.generation=2n;f.lastIntent=intent.digest;
 const result=await f.adapter.resolve(f.id,intent);assert.equal(result.outcome,'unknown');assert.equal(result.proof,null);
 assert.equal(f.sent.length,1); // resolve performs no repeat submission
});

test('exact signed transaction and reconstructed receipt trie confirm/finalize at authenticated ancestor',async()=>{
 const f=chainFixture(),intent=await prepare(f);await f.adapter.submit(f.id,intent);await f.mine(intent);
 const resolved=await f.adapter.resolve(f.id,intent);assert.equal(resolved.outcome,'confirmed',JSON.stringify(resolved));
 assert.equal(resolved.proof.transactionHash,f.txHash);assert.equal(resolved.proof.chargedWei,'1');assert.equal(resolved.verified,true);
 assert.equal((await f.adapter.finalize(f.id,intent)).outcome,'finalized');
 await assert.rejects(f.adapter.submit(f.id,intent),/already executed/);assert.equal(f.sent.length,1);
});

test('receipt/root/calldata location tampering never confirms the assignment alone',async()=>{
 const f=chainFixture(),intent=await prepare(f);await f.adapter.submit(f.id,intent);await f.mine(intent);
 const original=structuredClone(f.block);
 for(const change of [b=>{b.receipts[0].status='0x0';},b=>{b.transactions[0]=b.transactions[0].slice(0,-2)+'00';},
  b=>{b.receipts[0].logs[1].data='0x'+'00'.repeat(32);},b=>{b.header.parentHash='0x'+'ab'.repeat(32);}]){
  f.block=structuredClone(original);change(f.block);const r=await f.adapter.resolve(f.id,intent);
  assert.equal(r.outcome,'unknown');assert.equal(r.verified,false);assert.equal(r.proof,null);assert.ok(r.proofError);
 }
});

test('artifact identity and schema3 bundle pins remain exact',()=>{
 assert.ok(loadHostRegistryArtifact().runtimeCodeHash);assert.throws(()=>validateHostRegistryArtifact(Buffer.from('{}')),/not the pinned/);
 const b=loadSchema3Bundle('bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e');assert.equal(b.schema,1);
 assert.throws(()=>validateSchema3Bundle(Buffer.from(JSON.stringify(b)),'0'.repeat(64)),/not the pinned/);
});


test('large on-chain generation, revision and emergency counters refuse rather than round',async()=>{
 for(const key of ['generation','revision']){const f=chainFixture();f[key]=BigInt(Number.MAX_SAFE_INTEGER)+2n;
  await assert.rejects(f.adapter.read(f.id),/inexact/);assert.equal(f.sent.length,0);}
 const f=chainFixture();assert.throws(()=>schema3Emergency([BigInt(Number.MAX_SAFE_INTEGER)+2n,0n,false,false,f.host,f.operator.address],null,{}),/represented exactly/);
});
