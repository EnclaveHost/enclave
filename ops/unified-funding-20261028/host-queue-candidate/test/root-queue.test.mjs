import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TxQueue} from '../patched/relay/sessions.mjs';
import {TO, DATA, scripted, fakeTime, memJournal, makeCanonical, makePreconfirmed, txh} from './fixture-rpc.mjs';
const item={to:TO,data:DATA,label:'root'};
function setup(journal=memJournal()) {
 const c=scripted();const t=fakeTime();
 const q=new TxQueue({...c,journal,log:()=>{},alert:()=>{},receiptTimeoutMs:10,pollMs:5,maxAttempts:2,sleep:t.sleep,clock:t.clock});
 return {...c,q,journal};
}
for(const [name, mutate] of [
 ['missing log metadata', l=>{delete l.blockHash;delete l.transactionHash;}],
 ['removed log', l=>{l.removed=true;}],
 ['wrong log height', l=>{l.blockNumber=102n;}],
]) test(`root: queue rejects ${name} as completion`, async()=>{
 const x=setup(); x.s.afterSend=h=>{
  const r=makeCanonical(x.s,h);
  const l={blockHash:r.blockHash,blockNumber:r.blockNumber,transactionHash:h,removed:false};mutate(l);r.logs=[l];
 };
 await assert.rejects(x.q.send(item),{status:503,code:'tx_pending'});
 assert.notEqual(x.journal.data.txs[0].status,'mined');
});
test('root: pending nonce cannot be reused for a different call when provider pending count lags',async()=>{
 const x=setup();x.s.afterSend=h=>makePreconfirmed(x.s,h);
 await assert.rejects(x.q.send(item),{status:503,code:'tx_pending'});
 const n=x.s.sends.length;
 await assert.rejects(x.q.send({...item,data:'0x12345678'}),{status:503,code:'nonce_busy'});
 assert.equal(x.s.sends.length,n);
});
test('root: a restarted queue respects a journal-owned unresolved nonce',async()=>{
 const j=memJournal();j.data.txs.push({nonce:7,status:'stuck',to:TO,hashes:[txh(9)]});
 const x=setup(j);x.s.afterSend=h=>makeCanonical(x.s,h);
 await assert.rejects(x.q.send({...item,data:'0x12345678'}),{status:503,code:'nonce_busy'});
 assert.equal(x.s.sends.length,0);
});
test('root: nonce ownership is durable before broadcast and ambiguous send failure cannot authorize another call',async()=>{
 const x=setup();let flushed=false;
 x.wc.sendTransaction=async()=>{flushed=x.journal.flushes>0;throw new Error('network timeout after possible submission');};
 await assert.rejects(x.q.send(item),/network timeout/);
 assert.equal(flushed,true);
 let calls=0;x.wc.sendTransaction=async()=>{calls++;return txh(8);};
 await assert.rejects(x.q.send({...item,data:'0x12345678'}),{status:503,code:'nonce_busy'});
 assert.equal(calls,0);
});
test('root: canonical reconciliation releases an older journal nonce before next call',async()=>{
 const j=memJournal();j.data.txs.push({nonce:7,status:'stuck',to:TO,hashes:[txh(9)]});
 const x=setup(j);makeCanonical(x.s,txh(9));x.s.afterSend=h=>makeCanonical(x.s,h);
 await x.q.send(item);
 assert.deepEqual(x.s.sends.map(r=>r.nonce),[8]);
 assert.equal(j.data.txs[0].status,'mined');
});
test('root: journal pressure cannot discard unresolved nonce ownership',async()=>{
 const j=memJournal();for(let i=0;i<500;i++)j.data.txs.push({nonce:i,status:'stuck',hashes:[txh(i+1)]});
 const x=setup(j);x.s.pendingNonce=500;
 await assert.rejects(x.q.send(item),{status:503,code:'journal_full'});
 assert.equal(j.data.txs.length,500);assert.equal(j.data.txs[0].nonce,0);assert.equal(x.s.sends.length,0);
});
