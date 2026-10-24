import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { evalProof, proveConsumption } from '../driver/proof.mjs';
const id = '0x' + 'c1'.repeat(32);
const value = n => 'CANARY_20261024T000000Z_c1-rev1_' + n.repeat(64);
const current = { CANARY_A: value('a'), CANARY_B: value('b') }, old = { CANARY_A: value('c'), CANARY_B: value('d') };
const challenge = '34'.repeat(32);
// Independent reference computation, not the implementation's exported helper.
const body = (set, c) => ({v: 1, names: Object.keys(set).sort(), proofs: Object.fromEntries(Object.entries(set).map(([n,v]) =>
 [n,createHmac('sha256',Buffer.from(v,'utf8')).update(Buffer.concat([Buffer.from('enclave-custody-canary-proof-v1\n'),Buffer.from(n),Buffer.from('\n'),Buffer.from(c)])).digest('hex')]))});
const evaluate = b => evalProof({ challenge, body: b, required: [current], rejected: [old] });
test('consumption requires all expected current values and exact names', () => {
 assert.equal(evaluate(body(current,challenge)).outcome,'pass');
 for (const b of [body(old,challenge),body(current,'56'.repeat(32)),body({CANARY_A:current.CANARY_A},challenge),{...body(current,challenge),extra:'discard me'},
  {...body(current,challenge),names:['CANARY_A','CANARY_A']},{...body(current,challenge),v:2},{...body(current,challenge),proofs:{CANARY_A:'00'.repeat(32),CANARY_B:'00'.repeat(32)}},null])
  assert.equal(evaluate(b).outcome,'fail');
});
test('rejects ambiguity, real secret formats, old revisions, and malformed challenges', () => {
 assert.throws(()=>evalProof({challenge,body:{},required:[{CANARY_A:'ordinary credential'}]}),/dedicated/);
 assert.throws(()=>evalProof({challenge,body:{},required:[current,old]}),/conflict/);
 assert.throws(()=>evalProof({challenge:'bad',body:{},required:[current]}),/challenge/);
 assert.equal(evalProof({challenge,body:body(current,challenge),required:[current],rejected:[current]}).outcome,'fail');
});
const response = (text,headers={})=>new Response(text,{headers:{'content-type':'application/json','cache-control':'no-store',...headers}});
test('fresh challenge GET sends no markers or expected proofs; output contains no peer data', async () => {
 const seen=[];
 const fetchImpl = async (url,init)=>{seen.push({url,init}); return response(JSON.stringify(body(current,new URL(url).searchParams.get('c'))));};
 const a=await proveConsumption({id,required:[current],rejected:[old],fetchImpl});
 const b=await proveConsumption({id,required:[current],rejected:[old],fetchImpl});
 assert.equal(a.outcome,'pass');assert.equal(b.outcome,'pass');assert.notEqual(a.evidence.challenge,b.evidence.challenge);
 assert.equal(seen[0].init.redirect,'error');assert.equal(seen[0].init.method,'GET');assert.equal(seen[0].init.body,undefined);
 assert.match(seen[0].url,/^https:\/\/c1c1c1c1\.app\.enclave\.host\/canary\/proof\?c=[0-9a-f]{64}$/);
 for (const v of Object.values(current)) {assert.ok(!JSON.stringify(seen).includes(v));assert.ok(!JSON.stringify(a).includes(v));}
});
test('transport/status/cache/shape failures cannot become consumption evidence',async()=>{
 for (const fetchImpl of [async()=>new Response('',{status:503}),async()=>response('secret '+current.CANARY_A),
  async()=>response('{}',{'cache-control':'max-age=3600'}),async()=>response('{}',{'content-type':'text/html'}),
  async()=>response('x'.repeat(4097)),async()=>response('{}',{'content-length':'5000'}),async()=>{throw new Error(current.CANARY_A);}]) {
  const r=await proveConsumption({id,required:[current],fetchImpl});assert.equal(r.outcome,'fail');assert.ok(!JSON.stringify(r).includes(current.CANARY_A));
 }
 await assert.rejects(proveConsumption({id:'http://arbitrary',required:[current]}),/deployment/);
});
