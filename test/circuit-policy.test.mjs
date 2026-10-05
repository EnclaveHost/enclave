import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import {nknAmount, selectCircuitProviders, validateCircuitPolicy} from '../network/circuit-policy.mjs';
import {createAppIngress} from '../network/app-ingress.mjs';

const app = '0x' + 'ab'.repeat(32);
const policy = {version:2, deploymentId:app, mode:'guarded', directFallback:false, routes:2, maxPrice:'0.0002', budgetNkn:'1', diversity:'beneficiary-and-network', providers:{}};
const node = n => ({identity:n.toString(16).padStart(64,'0'), address:`8.1.1.${n}`, price:'0.0002', beneficiary:`wallet${n}`, asn:100+n, services:['reverse','socksproxy'], expiresAt:Date.now()+60000, successRate:1, latencyMs:n});

test('selection refuses shared operators, unknown diversity, stale providers and unsafe fallback', () => {
  const inventory=[1,2,3,4,5,6].map(node);
  assert.equal(selectCircuitProviders(policy,inventory).ready,true);
  assert.equal(selectCircuitProviders(policy,inventory.map(n=>({...n,beneficiary:'same'}))).ready,false);
  assert.equal(selectCircuitProviders(policy,inventory.map(n=>({...n,asn:null}))).ready,false);
  assert.equal(selectCircuitProviders(policy,inventory.map(n=>({...n,expiresAt:0}))).ready,false);
  assert.equal(selectCircuitProviders(policy,inventory.map(n=>({...n,price:'0.00020001'}))).ready,false);
  assert.throws(()=>validateCircuitPolicy({...policy,directFallback:true}),/fallback/);
  assert.equal(nknAmount('0.00000001'),1n);
  assert.throws(()=>nknAmount('0.000000001'));
});

test('owner exclusions and allowlists override speed and defaults', () => {
  const inventory=[1,2,3,4,5,6].map(node);
  const p={...policy,providers:{public:{allow:[node(2).identity,node(4).identity],deny:[node(2).identity]}}};
  const result=selectCircuitProviders(p,inventory);
  assert.equal(result.ready,false);
  assert.ok(result.circuits.every(c=>c.public.identity===node(4).identity));
  assert.throws(()=>validateCircuitPolicy({...policy,providers:{public:{prefer:[node(2).identity],deny:[node(2).identity]}}}),/forbidden/);
});

test('edge roles preserve failure domains for the sibling while respecting owner preferences', () => {
  const inventory=[1,2,3,4,5,6].map(node);
  for(const n of inventory)n.outcomes={egress:{successRate:n.asn>=105?1:0.8}};
  const p={...policy,providers:{guard:{allow:[node(1).identity,node(3).identity]},public:{allow:[node(2).identity,node(4).identity]}}};
  const compact=selectCircuitProviders(p,inventory);
  assert.equal(compact.ready,true);
  assert.ok(compact.circuits.every(c=>c.public.identity===c.egress.identity));
  assert.equal(new Set(compact.circuits.flatMap(c=>Object.values(c).map(n=>n.asn))).size,4);
  const preferred=selectCircuitProviders({...p,providers:{...p.providers,egress:{prefer:[node(6).identity]}}},inventory);
  assert.equal(preferred.ready,true);
  assert.ok(preferred.circuits.some(c=>c.egress.identity===node(6).identity));
});

test('per-app TLS ingress refuses another app and revokes open connections', async t => {
  let allowed=true, forwarded=0, resolve;
  const arrived=new Promise(r=>resolve=r);
  const ingress=await createAppIngress({deploymentId:app,names:['app.example'],authorize:id=>allowed&&id===app,
    forward:(socket,id)=>{assert.equal(id,app);forwarded++;resolve();}});
  t.after(()=>ingress.close());
  const cross=tls.connect({host:'127.0.0.1',port:ingress.port,servername:'other.example'});cross.on('error',()=>{});
  await new Promise(r=>cross.once('close',r));assert.equal(forwarded,0);
  const client=tls.connect({host:'127.0.0.1',port:ingress.port,servername:'app.example'});client.on('error',()=>{});t.after(()=>client.destroy());
  await arrived;assert.equal(forwarded,1);
  const closed=new Promise(r=>client.once('close',r));allowed=false;ingress.revoke();await closed;
  assert.equal(client.destroyed,true);
});

test('an untried provider on a failing network ranks below one on a working network', () => {
  const o = (known, successRate, networkRate) => ({known, successRate, ...(networkRate === undefined ? {} : {networkRate})});
  const withOutcomes = (n, publicOutcome) => ({...node(n), successRate: undefined, latencyMs: 1, outcomes: {guard: o(true, 1), public: publicOutcome, egress: o(true, 1)}});
  // Same latency everywhere; only the public-role record differs.
  const inventory = [1, 2, 3, 4].map(n => withOutcomes(n, o(true, 0.6)));
  const deadNetwork = withOutcomes(5, o(false, 0.5, 0.05)), goodNetwork = withOutcomes(6, o(false, 0.5, 0.9)), unknownNetwork = withOutcomes(7, o(false, 0.5));
  const result = selectCircuitProviders(policy, [deadNetwork, unknownNetwork, goodNetwork, ...inventory]);
  assert.equal(result.ready, true);
  const order = [deadNetwork, unknownNetwork, goodNetwork].map(n => result.circuits.some(c => c.public.identity === n.identity));
  // The good network's untried node is used ahead of the unknown and dead ones.
  assert.equal(order[2], true);
  assert.equal(order[0], false);
});

test('a guard is ranked by the allocations it carries, not only its own uptime', () => {
  const o = (known, successRate) => ({known, successRate});
  const mk = (n, carry) => ({...node(n), successRate: undefined, latencyMs: 1, outcomes: {guard: o(true, 0.95), public: o(true, 1), egress: o(true, 1), ...(carry ? {carry} : {})}});
  // Guard 1 is fastest by identity order but has failed to carry allocations.
  const badCarrier = mk(1, o(true, 0.1)), goodCarrier = mk(2, o(true, 0.9)), untried = mk(3);
  const others = [4, 5, 6, 7, 8].map(n => mk(n, o(true, 0.9)));
  const result = selectCircuitProviders(policy, [badCarrier, untried, goodCarrier, ...others]);
  assert.equal(result.ready, true);
  const guards = result.circuits.map(c => c.guard.identity);
  assert.ok(!guards.includes(badCarrier.identity));
  assert.ok(guards.includes(goodCarrier.identity));
});
