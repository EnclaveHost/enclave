import test from 'node:test';
import assert from 'node:assert/strict';
import {claimCheapest} from '../relay/cheapest-claim.mjs';
const host=(name,rate,extra={})=>({name,rate,claimable:true,...extra});
async function run(pool,reject=[]) {
 const calls=[];const result=await claimCheapest({pool,quote:async h=>h,hint:async h=>{
   calls.push(h.name);return reject.includes(h.name)?{accepted:false,reason:'capacity unavailable'}:{accepted:true};
 }});return {calls,result};
}
test('owner self-hosting takes preference, including a free-price tie',async()=>{
 const {calls,result}=await run([host('a-free',0),host('z-own',0,{selfHosted:true}),host('paid',5)]);
 assert.deepEqual(calls,['z-own']);assert.equal(result.ratePerSec6,'0');
});
test('full own host falls back to the lowest cost available host',async()=>{
 const {calls}=await run([host('expensive',30),host('cheap',2),host('own',1,{selfHosted:true})],['own']);
 assert.deepEqual(calls,['own','cheap']);
});
test('above-cap or unfunded quotes never receive hints, even for the owner',async()=>{
 const {calls}=await run([host('own',0,{selfHosted:true,claimable:false}),host('too-dear',10,{claimable:false}),host('fits',3)]);
 assert.deepEqual(calls,['fits']);
});
test('quote errors fail closed, and prices retain integer precision',async()=>{
 const {calls}=await run([host('unknown',undefined),host('larger','9007199254740994'),host('smaller','9007199254740993')]);
 assert.deepEqual(calls,['smaller']);
 const r=await claimCheapest({pool:[{}],quote:async()=>{throw Error('RPC down')},hint:()=>assert.fail('unpriced host hinted')});
 assert.equal(r.accepted,false);assert.match(r.reason,/confirm.*prices/);
});
