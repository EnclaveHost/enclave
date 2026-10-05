import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {AutomaticConversion} from '../network/conversion/automatic.mjs';
import {ASSETS,decimalUnits,conversionIntent,validateQuote} from '../network/conversion/policy.mjs';
import {classifyAssets,discoverConversion} from '../network/conversion/swft-discovery.mjs';
const policy={version:1,payoutCurrency:'USDC',allowExternal:true,reserveNkn8:'100000000',refillBelowNkn8:'10000000',buyUsdc6:'1000000',maxConversionUsdc6:'3000000',dailyConversionUsdc6:'4000000',maxSellNkn8:'200000000',minNknPerUsdc8:'100000000',minUsdcPerNkn6:'100000',maxSlippageBps:100,expiresAt:900000000};
const addresses={USDC:'0x'+'12'.repeat(20),NKN:'provider-native-wallet'};
async function fixture(t,{sell=false}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'enclave-conversion-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const f={now:100000000,opens:0,prepares:0,broadcasts:[],funding:'missing',report:{state:'pending'},balance:sell?{usdc6:'0',nkn8:'300000000'}:{usdc6:'2000000',nkn8:'0'}};
 const quote=()=>({id:'quote-1',inputAsset:ASSETS[sell?'NKN':'USDC'].id,outputAsset:ASSETS[sell?'USDC':'NKN'].id,amountIn:sell?'200000000':'1000000',expectedOut:sell?'1000000':'200000000',minimumOut:sell?'995000':'199000000',allInUsdc6:'1010000',minimumEnforced:true,custody:'external',recipient:addresses[sell?'USDC':'NKN'],refundAddress:addresses[sell?'NKN':'USDC'],expiresAt:f.now+60000});
 f.route={quote:async()=>quote(),open:async({quote:q})=>{f.opens++;f.order={...q,id:'order-1',quoteId:q.id,depositAddress:'exchange-deposit'};return f.order;},lookup:async()=>f.order,status:async()=>f.report};
 f.wallet={balances:async()=>f.balance,validateAddress:async()=>{},prepareTransfer:async()=>{f.prepares++;return {raw:'signed-once',hash:'funding-1'};},validatePrepared:async({signed})=>assert.equal(signed.raw,'signed-once'),fundingStatus:async()=>f.funding,broadcast:async s=>f.broadcasts.push(s.raw),verifyTransfer:async()=>f.proof};
 f.options={directory,policy,addresses,route:f.route,wallet:f.wallet,now:()=>f.now};f.worker=new AutomaticConversion(f.options);return f;
}
test('amounts stay exact and directions use provider inventory, not app credit',()=>{
 assert.equal(decimalUnits('1.000001',6),1000001n);assert.equal(decimalUnits('0.00000001',8),1n);
 for(const v of ['1e2','-1','0.000000001','NaN'])assert.throws(()=>decimalUnits(v,8));
 assert.equal(conversionIntent(policy,{usdc6:'1000000',nkn8:'0'},100).direction,'USDC_TO_NKN');
 assert.equal(conversionIntent(policy,{usdc6:'0',nkn8:'300000000'},100).direction,'NKN_TO_USDC');
 assert.equal(conversionIntent(policy,{usdc6:'0',nkn8:'50000000'},100),null);
});
for(const sell of [false,true])test(`${sell?'NKN to USDC':'USDC to NKN'} completes only after destination transfer confirmation`,async t=>{
 const f=await fixture(t,{sell});assert.equal((await f.worker.tick()).state,'pending');assert.equal(f.prepares,1);
 f.funding='confirmed';f.report={state:'received',hash:'received-1'};
 await assert.rejects(f.worker.tick(),/not verified/);
 f.proof={hash:'received-1',finalized:true,asset:ASSETS[sell?'USDC':'NKN'].id,recipient:addresses[sell?'USDC':'NKN'],transferId:'received-1:0',timestamp:f.now,amount:sell?'1000000':'200000000'};
 assert.equal((await f.worker.tick()).state,'completed');
});
test('uncertain broadcast and restart reuse identical signed bytes',async t=>{
 const f=await fixture(t);f.wallet.broadcast=async s=>{f.broadcasts.push(s.raw);throw Error('connection lost');};
 await assert.rejects(f.worker.tick(),/connection lost/);f.worker=new AutomaticConversion(f.options);
 await assert.rejects(f.worker.tick(),/connection lost/);assert.equal(f.opens,1);assert.equal(f.prepares,1);assert.deepEqual(f.broadcasts,['signed-once','signed-once']);
});
test('unknown order creation reconciles without creating or funding a second order',async t=>{
 const f=await fixture(t),open=f.route.open;
 f.route.open=async x=>{await open(x);throw Error('lost order response');};
 await assert.rejects(f.worker.tick(),/lost order/);f.worker=new AutomaticConversion(f.options);
 assert.equal((await f.worker.tick()).state,'pending');assert.equal(f.opens,1);assert.equal(f.prepares,1);
});
test('unavailable route never opens an order or signs funds',async t=>{
 const f=await fixture(t);f.route.quote=async()=>null;assert.equal((await f.worker.tick()).state,'unavailable');assert.equal(f.opens,0);assert.equal(f.prepares,0);
});
test('unprotected rates, altered assets, addresses, fees and expired quotes fail before funding',async t=>{
 const f=await fixture(t),q=await f.route.quote(),intent={direction:'USDC_TO_NKN',amount:'1000000'};
 for(const change of [{minimumEnforced:false},{outputAsset:'ethereum:erc20:NKN'},{recipient:'someone-else'},{refundAddress:'someone-else'},{allInUsdc6:'3000001'},{minimumOut:'1'},{expiresAt:f.now-1}])assert.throws(()=>validateQuote({...q,...change},{policy,intent,addresses,now:f.now}));
 assert.throws(()=>validateQuote(q,{policy:{...policy,allowExternal:false},intent,addresses,now:f.now}),/trust/);
});
test('daily limit survives restart and concurrent ticks never produce concurrent orders',async t=>{
 const f=await fixture(t);await Promise.all([f.worker.tick(),f.worker.tick(),f.worker.tick()]);assert.equal(f.opens,1);assert.equal(f.prepares,1);
 const s=await f.worker.store.get('conversion');s.job=null;s.days[String(Math.floor(f.now/86400000))]='3500000';await f.worker.store.set('conversion',s);
 f.worker=new AutomaticConversion(f.options);assert.equal((await f.worker.tick()).state,'limited');assert.equal(f.opens,1);
});
test('short payment blocks retries and is never recorded at the expected amount',async t=>{
 const f=await fixture(t);await f.worker.tick();f.funding='confirmed';f.report={state:'received',hash:'short'};
 f.proof={hash:'short',asset:ASSETS.NKN.id,recipient:addresses.NKN,finalized:true,timestamp:f.now,transferId:'short:0',amount:'1'};
 assert.equal((await f.worker.tick()).state,'needs_review');assert.equal((await f.worker.tick()).state,'needs_review');
 assert.equal((await f.worker.store.get('conversion')).last.amount,'1');assert.equal(f.opens,1);
});
test('expired deposit is held for reconciliation rather than sent into an expired order',async t=>{
 const f=await fixture(t);await f.worker.tick();f.now+=70000;assert.equal((await f.worker.tick()).reason,'funding_reconciliation');assert.equal(f.broadcasts.length,1);
});
test('asset discovery distinguishes native NKN from ERC-20 and unsupported-pair text',async()=>{
 const data=[{coinCode:'USDC(BASE)',mainNetwork:'BASE',contact:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',coinDecimal:6},{coinCode:'NKN',mainNetwork:'ETH',contact:'0x123',coinDecimal:18},{coinCode:'GLM',noSupportCoin:'NKN'}];
 assert.deepEqual(classifyAssets(data),{baseUSDC:true,nativeNKN:false});
 const result=await discoverConversion({fetcher:async()=>({ok:true,text:async()=>JSON.stringify({resCode:'800',data})})});assert.equal(result.executable,false);assert.equal(result.reason,'native_pair_unavailable');
});

test('confirmed refund returns actual source funds and keeps its daily reservation',async t=>{
 const f=await fixture(t);await f.worker.tick();f.funding='confirmed';f.report={state:'refunded',hash:'refund-1'};
 f.proof={hash:'refund-1',asset:ASSETS.USDC.id,recipient:addresses.USDC,finalized:true,timestamp:f.now,transferId:'refund-1:0',amount:'1000000'};
 assert.equal((await f.worker.tick()).state,'refunded');const s=await f.worker.store.get('conversion');assert.equal(s.days['1'],'1010000');assert.equal(s.job,null);
});
test('mismatched, stale, unfinalized or reused destination receipts cannot complete a conversion',async t=>{
 const f=await fixture(t);await f.worker.tick();f.funding='confirmed';f.report={state:'received',hash:'proof-1'};
 const proof={hash:'proof-1',asset:ASSETS.NKN.id,recipient:addresses.NKN,finalized:true,timestamp:f.now,transferId:'proof-1:0',amount:'200000000'};
 for(const change of [{hash:'other'},{asset:ASSETS.USDC.id},{recipient:'other'},{finalized:false},{timestamp:f.now-1},{timestamp:undefined}]){f.proof={...proof,...change};await assert.rejects(f.worker.tick(),/not verified/);}
 const s=await f.worker.store.get('conversion');s.usedTransfers[ASSETS.NKN.id+':proof-1:0']='prior-job';await f.worker.store.set('conversion',s);f.proof=proof;await assert.rejects(f.worker.tick(),/already used/);
});
test('separate instances sharing a state directory still open one order',async t=>{
 const f=await fixture(t),other=new AutomaticConversion(f.options);await Promise.all([f.worker.tick(),other.tick()]);assert.equal(f.opens,1);assert.equal(f.prepares,1);
});
