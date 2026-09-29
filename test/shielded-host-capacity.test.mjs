import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shieldedHostCapacity} from '../site/js/core/pricing.js';
const card = (id, rate, free) => ({id, card:'Same GPU', vramGb:16, vramBudgetGb:12, vramFreeGb:10, cardTflops:rate, gpuShareFree:free});
const host = (shielded, shieldedCards, gpuShareFree) => ({availability:{shielded,shieldedCards,gpuShareFree}});
test('single Radeon preserves sub-TFLOPS measured equivalent and a fully leased budget',()=>{
 const p=shieldedHostCapacity(host({device:'Radeon',vramGb:16,vramBudgetGb:12,vramFreeGb:0,vramReservedGb:12,cardTflops:0,gmacPerSec:174},null,0));
 assert.equal(p.total,12);assert.equal(p.tflops,0.348);assert.equal(p.availableTflops,0);assert.equal(p.basis,'measured');
});
test('pooled total includes both cards once',()=>{
 const p=shieldedHostCapacity(host({pooled:true,cardCount:2,vramGb:62,vramBudgetGb:62,vramFreeGb:1.86,cardTflops:214.7},[card(0,101.7,0.03),card(1,113,0.03)],0.03));
 assert.equal(p.total,62);assert.equal(p.tflops,214.7);assert.equal(p.cardCount,2);assert.ok(Math.abs(p.availableTflops-6.441)<1e-9);
});
test('distinct cards sum capacities with each own free share; duplicate primary never doubles',()=>{
 const a=card(0,10,0),b=card(1,20,0.5);
 const p=shieldedHostCapacity(host(a,[a,b,{...a}],0));
 assert.equal(p.total,24);assert.equal(p.leasableGb,6);assert.equal(p.tflops,30);assert.equal(p.availableTflops,10);assert.equal(p.frac,0.25);assert.equal(p.cardCount,2);
});
test('anonymous primary aliases inventory, identical names do not merge distinct cards',()=>{
 const p=shieldedHostCapacity(host({vramGb:16,card:'Same GPU'},[card(0,10,1),card(1,10,1)],1));
 assert.equal(p.cardCount,2);assert.equal(p.tflops,20);
});
test('never adds rated and measured rates; uses common measured basis if complete',()=>{
 const a={...card(0,10,1),gmacPerSec:100},b={...card(1,0,0.5),gmacPerSec:200};
 let p=shieldedHostCapacity(host(a,[a,b],1));
 assert.equal(p.basis,'measured');assert.ok(Math.abs(p.tflops-0.6)<1e-9);assert.equal(p.availableTflops,0.4);
 p=shieldedHostCapacity(host({...a,gmacPerSec:0},[{...a,gmacPerSec:0},b],1));assert.equal(p.tflops,null);assert.equal(p.availableTflops,null);
});
test('withdrawn cards are excluded and missing primary returns no capacity',()=>{
 const a=card(0,10,1), b={...card(1,20,1),available:false};
 assert.equal(shieldedHostCapacity(host(a,[a,b],1)).tflops,10);
 assert.equal(shieldedHostCapacity({}),null);
});
test('pool can derive complete rated rate from member inventory without adding pool again',()=>{
 const p=shieldedHostCapacity(host({pooled:true,cardCount:2,vramGb:24,vramFreeGb:24},[card(0,10,1),card(1,20,1)],1));
 assert.equal(p.tflops,30);assert.equal(p.total,24);
});

test('primary identified by id matches inventory that also supplies UUID',()=>{
 const primary=card(0,10,1), member={...primary,deviceUuid:'uuid-0'};
 const p=shieldedHostCapacity(host(primary,[member,card(1,20,1)],1));
 assert.equal(p.cardCount,2);assert.equal(p.tflops,30);
});
