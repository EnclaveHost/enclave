import test from 'node:test';import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';
import {canonical,receiptData,verifyReceipt} from '../availability/evidence.mjs';
const accounts=[1,2,3,4].map(i=>privateKeyToAccount('0x'+String(i).padStart(64,'0')));
const [a,b,c,host]=accounts;
const options={chainId:8453,contract:'0x'+'12'.repeat(20),quorum:2,nowSec:100n,kind:'capacity',hostOperator:host.address,
 signers:Object.fromEntries(accounts.map((x,i)=>[x.address.toLowerCase(),'group'+i]))};
const payload={kind:'capacity',issuedSec:'90',expiresSec:'110',hostId:'host',units:'100'};
const envelope=async(p=payload,which=[a,b])=>({payload:p,signatures:await Promise.all(which.map(x=>x.signTypedData(receiptData(p,options))))});
test('independent signed groups bind payload, chain and contract',async()=>{
 const e=await envelope();assert.deepEqual(await verifyReceipt(e,options),payload);
 await assert.rejects(verifyReceipt({...e,payload:{...payload,units:'1000'}},options));
 await assert.rejects(verifyReceipt(e,{...options,chainId:1}));
 await assert.rejects(verifyReceipt(e,{...options,contract:'0x'+'13'.repeat(20)}));
});
test('duplicates, aliases and host group cannot satisfy quorum',async()=>{
 await assert.rejects(verifyReceipt(await envelope(payload,[a,a]),options));
 await assert.rejects(verifyReceipt(await envelope(),{...options,signers:{...options.signers,[b.address.toLowerCase()]:'group0'}}));
 await assert.rejects(verifyReceipt(await envelope(payload,[a,host]),options));
 await assert.rejects(verifyReceipt(await envelope(),{...options,signers:{...options.signers,[a.address.toLowerCase()]:'group3'}}));
});
test('stale, future, wrong-kind and missing identity receipts fail',async()=>{
 for(const p of [{...payload,expiresSec:'100'},{...payload,issuedSec:'101'},{...payload,kind:'result'}])await assert.rejects(verifyReceipt(await envelope(p),options));
 await assert.rejects(verifyReceipt(await envelope(),{...options,hostOperator:undefined}));
 assert.throws(()=>canonical({units:100}),/decimal strings/);
 assert.equal(canonical({b:'2',a:'1'}),canonical({a:'1',b:'2'}));
});
test('operator bootstrap is explicit and cannot be relabeled independent',async()=>{
 const p={...payload,trustMode:'operator-bootstrap'};const e=await envelope(p,[host]);
 assert.deepEqual(await verifyReceipt(e,{...options,quorum:1,trustMode:'operator-bootstrap'}),p);
 await assert.rejects(verifyReceipt(e,options),/not independent/);
 await assert.rejects(verifyReceipt(await envelope(payload,[host]),{...options,quorum:1,trustMode:'operator-bootstrap'}),/labeled/);
});
