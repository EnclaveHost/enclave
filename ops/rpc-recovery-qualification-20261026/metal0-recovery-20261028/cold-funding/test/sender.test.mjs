// Actual sender + Anvil EIP-7702 processing; generated local keys only.
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startWorld,instantClock,quiesceFor,ID1,ID2,pad32} from './env.mjs';
import {createPreparer,sha256,timingSha256,designatorOf,nonceSlot} from '../lib/maintenance.mjs';
import {createSender,APPROVAL_KIND} from '../lib/sender.mjs';
import {httpRpc,PACING} from '../vendor/publish.mjs';
let w,dirs=[];
before(async()=>{w=await startWorld()});
after(async()=>{await w?.close();for(const d of dirs)fs.rmSync(d,{recursive:true,force:true})});
beforeEach(async()=>{await w.reset()});
const dir=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'custody-sender-test-'));dirs.push(d);return d};
async function setup(){
 const clock=instantClock(), pacing={...PACING,minIntervalMs:0,maxRequests:100,timeBudgetMs:120000,freshnessMs:120000};
 const p=await createPreparer({cfg:w.cfg,fixture:true,clock,pacing}).prepare({quiesce:await quiesceFor(w)});
 const cfg=w.cfg;
 const a={kind:APPROVAL_KIND,approvedBy:'root',planHash:p.planHash,timingProfileSha256:timingSha256(cfg.timing),expiresAt:Math.floor(clock.now()/1000)+300};
 for(const k of ['chainId','operator','executor','sponsor','valueWei','feeCapWei'])a[k]=typeof cfg[k]==='bigint'?String(cfg[k]):cfg[k];
 a.humanApprovals=[{role:'c9-key-holder',by:'throwaway local test',at:'fixture'},{role:'sponsor-owner',by:'throwaway local test',at:'fixture'}];
 const approvalText=JSON.stringify(a), approvalSha256='0x'+sha256(approvalText);
 let signs=0,sends=0,dropB=false,dropAll=false,wrongReceipts=false,preconfirmed=false;
 const signers={operator:{address:w.keys.O.address,signAuthorization:async t=>{signs++;return w.keys.O.signAuthorization({chainId:t.chainId,contractAddress:t.address,nonce:t.nonce})}},sponsor:{address:w.keys.S.address,signTransaction:async t=>{signs++;return w.keys.S.signTransaction(t)}}};
 const base=httpRpc();
 const rpc=async(u,m,ps)=>{
  if(m==='eth_sendRawTransaction'){
   sends++;
   if(dropAll || (dropB&&sends>2))throw new Error('test network outage');
   const r=await base(u,m,ps);await w.mine(3);return r;
  }
  const r=await base(u,m,ps);
  if(preconfirmed&&m==='eth_getTransactionReceipt'&&r)return {...r,blockHash:'0x'+'00'.repeat(32)};
  if(wrongReceipts&&m==='eth_getTransactionReceipt'&&r&&u===cfg.rpcs[1])return {...r,status:r.status==='0x1'?'0x0':'0x1'};
  return r;
 };
 const journalDir=dir();
 const sender=createSender({cfg,fixture:true,clock,pacing,rpc,signers,journalDir,pollMs:1000});
 return {p,a,clock,journalDir,sender,signers,rpc,pacing,run:()=>sender.run({planText:p.text,approvalText,approvalSha256}),
   counts:()=>({signs,sends}),dropB:v=>dropB=v,dropAll:v=>dropAll=v,wrongReceipts:v=>wrongReceipts=v,preconfirmed:v=>preconfirmed=v};
}
test('happy path verifies both transactions, exact delegation, funded balance, and unchanged lease state',async()=>{
 const x=await setup(),r=await x.run();assert.equal(r.status,'verified');assert.equal(x.counts().signs,4);
 assert.equal(await w.raw('eth_getCode',[w.keys.O.address,'latest']),designatorOf(w.cfg.executor));
 assert.equal(await w.raw('eth_getStorageAt',[w.keys.O.address,nonceSlot(w.cfg,ID1),'latest']),pad32(7));
 assert.equal(await w.raw('eth_getStorageAt',[w.keys.O.address,nonceSlot(w.cfg,ID2),'latest']),pad32(3));
 assert.equal(fs.statSync(path.join(x.journalDir,x.p.planHash+'.json')).mode&0o777,0o600);
 await assert.rejects(x.run(),e=>e.code==='journal');assert.equal(x.counts().signs,4);
});
test('first transaction mined, second unavailable: resume sends identical bytes without signing',async()=>{
 const x=await setup();x.dropB(true);const r=await x.run();assert.equal(r.status,'recovery-required');
 assert.equal(await w.raw('eth_getCode',[w.keys.O.address,'latest']),'0x');
 const before=JSON.parse(fs.readFileSync(path.join(x.journalDir,x.p.planHash+'.json')));
 x.dropB(false);const rr=await x.sender.resume({planText:x.p.text,rebroadcast:true});assert.equal(rr.status,'verified');assert.equal(x.counts().signs,4);
 const after=JSON.parse(fs.readFileSync(path.join(x.journalDir,x.p.planHash+'.json')));assert.deepEqual(before.raw,after.raw);
});
test('missing approval and executable observation refuse before signing or broadcasting',async()=>{
 const x=await setup();await assert.rejects(x.sender.run({planText:x.p.text,approvalText:'{}',approvalSha256:'0x'+sha256('{}')}),e=>e.code==='approval');
 const o=await createPreparer({cfg:w.cfg,fixture:true,clock:x.clock,pacing:x.pacing}).observe({leaseIds:[ID1,ID2]});
 await assert.rejects(x.sender.run({planText:o.text}),e=>e.code==='plan');assert.deepEqual(x.counts(),{signs:0,sends:0});
});
test('stale operator nonce refuses without signing',async()=>{
 const x=await setup();await w.raw('anvil_setNonce',[w.keys.O.address,'0x10']);await w.mine(3);
 await assert.rejects(x.run(),e=>['nonce','state_changed'].includes(e.code));assert.equal(x.counts().signs,0);
});
test('changed fee quote refuses without signing',async()=>{
 const x=await setup();w.state.tip='0x1e8480';await assert.rejects(x.run(),e=>e.code==='fees');assert.equal(x.counts().signs,0);
});
test('provider receipt status disagreement cannot produce success',async()=>{
 const x=await setup();x.wrongReceipts(true);const r=await x.run();assert.notEqual(r.status,'verified');
 x.wrongReceipts(false);assert.equal((await x.sender.resume({planText:x.p.text})).status,'verified');assert.equal(x.counts().signs,4);
});
test('no broadcast can occur before a durable journal exists',async()=>{
 const x=await setup();fs.chmodSync(x.journalDir,0o755);await assert.rejects(x.run(),e=>e.code==='journal');assert.equal(x.counts().sends,0);
});
test('expired plan refuses without signing',async()=>{
 const x=await setup();x.clock.t+=301000;await assert.rejects(x.run(),e=>e.code==='approval');assert.equal(x.counts().signs,0);
});

test('zero-hash Base preconfirmation receipts cannot verify or be classified as stale restoration',async()=>{
 const x=await setup();x.preconfirmed(true);const r=await x.run();assert.equal(r.status,'recovery-required');assert.equal(r.outcome.state,'pending-confirmations');assert.equal(x.counts().signs,4);
 x.preconfirmed(false);const rr=await x.sender.resume({planText:x.p.text,rebroadcast:false});assert.equal(rr.status,'verified');assert.equal(x.counts().signs,4);
});
