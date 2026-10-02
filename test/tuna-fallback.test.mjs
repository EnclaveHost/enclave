import test from 'node:test';
import assert from 'node:assert/strict';
import {selectCircuitProviders,providerCooldownKey} from '../network/circuit-policy.mjs';
import {fallbackInventory,publicReservations} from '../network/public-fallback.mjs';
import {provisionFallback} from '../network/provider/fallback-config.mjs';

const id='0x'+'ab'.repeat(32),other='0x'+'cd'.repeat(32);
const node=n=>({identity:n.toString(16).padStart(64,'0'),address:`8.1.1.${n}`,beneficiary:'wallet'+n,asn:100+n,price:'0.0002',services:['reverse','socksproxy'],expiresAt:Date.now()+60000});
const nodes=[1,2,3,4,5,6,7,8].map(node),provider={identity:node(8).identity,address:node(8).address};
const fallback={...provider,httpsPort:20000,httpPort:20001};
const policy={version:2,deploymentId:id,mode:'guarded',directFallback:false,routes:2,maxPrice:'0.0002',budgetNkn:'1',diversity:'beneficiary-and-network'};

test('all apps can reserve separate ports on the same fallback, with independent guards and siblings',()=>{
  const taken=new Set([provider.address]);
  for(let i=0;i<20;i++){
    const inventory=fallbackInventory(nodes,{...fallback,httpsPort:20000+2*i,httpPort:20001+2*i});
    const choice=selectCircuitProviders(policy,inventory,{occupiedPublic:taken});
    assert.equal(choice.ready,true);assert.equal(choice.circuits[1].public.identity,provider.identity);
    assert.equal(choice.circuits[0].public.fallback,undefined);
    const backup=choice.circuits[1];assert.notEqual(backup.guard.asn,backup.public.asn);
    for(const a of Object.values(choice.circuits[0]))for(const b of Object.values(backup)){assert.notEqual(a.asn,b.asn);assert.notEqual(a.beneficiary,b.beneficiary);}
    publicReservations(backup.public).forEach(p=>taken.add(p));
  }
});
test('owner exclusions, price ceilings, occupied ports, and cooldowns still constrain a fleet fallback',()=>{
  const inventory=fallbackInventory(nodes,fallback),f=inventory.at(-1);
  for(const [p,opts] of [
    [{...policy,providers:{public:{deny:[provider.identity]}}},{}],
    [policy,{occupiedPublic:new Set([`${provider.address}:20000`])}],
    [policy,{cooldown:new Map([[providerCooldownKey('public',f),Date.now()+10000]])}],
  ]){
    const result=selectCircuitProviders(p,inventory,opts);assert.equal(result.ready,true);assert.ok(result.circuits.every(c=>!c.public.fallback));
  }
  const costly=inventory.map(n=>n.fallback?{...n,price:'0.01'}:n);
  assert.ok(selectCircuitProviders(policy,costly).circuits.every(c=>!c.public.fallback));
  const changed=fallbackInventory(nodes,{...fallback,address:'8.1.2.8'});assert.ok(changed.every(n=>!n.fallback));
  assert.notEqual(providerCooldownKey('public',f),providerCooldownKey('public',{...f,publicTcp:[20002,20003]}));
});
test('provisioning keeps ports stable, isolates apps, rejects aliases shared by apps, and emits no TLS termination',()=>{
  const apps=[{deploymentId:id,names:['one.example']},{deploymentId:other,names:['two.example','alias.example']}];
  const first=provisionFallback({provider,apps});
  assert.deepEqual(first.apps.map(a=>a.publicFallback.httpsPort),[20000,20002]);
  const next=provisionFallback({provider,apps:[apps[1]],allocations:first.allocations});
  assert.equal(next.apps[0].publicFallback.httpsPort,20002);
  assert.equal(next.allocations[id].httpsPort,20000); // retired ports aren't reassigned to another app
  assert.match(first.haproxy,/req.ssl_sni/);assert.match(first.haproxy,/mode tcp/);
  assert.doesNotMatch(first.haproxy,/\bssl\b|\bcrt\b|\bciphers\b/);
  assert.throws(()=>provisionFallback({provider,apps:[apps[0],{...apps[1],names:['one.example']}]}),/two apps/);
  assert.throws(()=>provisionFallback({provider,apps,allocations:{[id]:{httpsPort:443,httpPort:80}}}),/fallback/);
});
