import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {fixture,between,dep} from './helpers/supervisor-wallet-fixture.mjs';
function setup() {
 const f=fixture();const rec=f.serve(f.rec({status:'expired'}));let release;
 const pending=new Promise(r=>release=r);let lookups=0,allocations=0;
 Object.assign(f.ctx,{ISOLATION_BACKEND:true,isolationHeldGuest:async()=>{lookups++;await pending;return null;},
  vmHealth:async()=>null,isolationHeldSameRecord:()=>false,isolatedInference:()=>({}),neededVolumes:()=>[],
  CLAIM_TERMINAL:new Set(['expired','terminated','failed']),allocGpu:()=>{allocations++;return null;}});
 vm.runInContext(between('async function adopt(d, g, firewall, slice, { resume = false } = {}) {','\n// DIRECT_CLAIM_SELFTEST='),f.ctx);
 return {f,rec,release,start:()=>f.ctx.adopt(f.row(),{},[],{cpu:false},{resume:true}),lookups:()=>lookups,allocations:()=>allocations};
}
for(const kind of ['stop already pending','stop during lookup','wallet hold during lookup','withdrawal during lookup','stop completed during lookup','replacement record during lookup']) {
 test(`adopt defers: ${kind}`,async()=>{
  const p=setup();
  if(kind==='stop already pending')p.rec._stopPending={since:'test'};
  const adopting=p.start();
  if(kind==='stop during lookup')p.rec._stopPending={since:'test'};
  if(kind==='wallet hold during lookup')p.rec.walletHeld={stopConfirmed:true};
  if(kind==='withdrawal during lookup')p.f.ctx.noteWalletWithdrawn(dep);
  if(kind==='stop completed during lookup')p.f.ctx.revokeLeasePermits(p.rec);
  let expected=p.rec;
  if(kind==='replacement record during lookup'){expected=p.f.rec({status:'terminated'});p.f.ctx.deployments.set(dep,expected);}
  p.release();assert.equal(await adopting,false);
  assert.equal(p.allocations(),0);assert.equal(p.f.s.events.includes('freeGpu'),false);
  assert.equal(p.f.ctx.deployments.get(dep),expected);
  if(kind==='stop already pending')assert.equal(p.lookups(),0);
 });
}
test('unchanged terminal record reaches ordinary capacity allocation',async()=>{
 const p=setup();const adopting=p.start();p.release();assert.equal(await adopting,false);
 assert.equal(p.allocations(),1);assert.equal(p.f.s.events.filter(e=>e==='freeGpu').length,1);
 assert.equal(p.f.ctx.deployments.has(dep),false);
});
test('fresh adoption after an earlier withdrawal still starts the app',async()=>{
 const p=setup();p.f.ctx.noteWalletWithdrawn(dep);p.f.ctx.revokeLeasePermits(p.rec);
 Object.assign(p.f.ctx,{allocGpu:()=>({cpu:true,share:0.1}),overrideConfigFields:()=>({}),applyLiveOptions:()=>({}),
  _advertisedEndpoint:'https://host.example',vmTech:()=>null,gpuTechnology:()=>null,
  _provisionBackoff:new Map(),acmeReconcileSoon:()=>{},provisionTenant:async r=>{r.status='running';return true;}});
 const g={ref:'catalog://test/1',app:{slug:'test',version:'1'},wasmRef:'ipfs://test'};
 const adopting=p.f.ctx.adopt(p.f.row({createdAt:BigInt(Math.floor(Date.now()/1000))}),g,['http:8080'],{cpu:false},{resume:true});
 p.release();await adopting;assert.equal(p.f.ctx.deployments.get(dep).status,'running');
 assert.equal(p.f.s.events.filter(e=>e==='freeGpu').length,1);
});
