import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import(process.env.ORIGINAL_PREP ? '../root-original-prepare.mjs' : '../prepare-activation.mjs');
const now=1793224200;
function obs(){const b={number:'53217000',hash:'0x'+'ab'.repeat(32),timestamp:String(now-10),baseFeePerGas:'1000000'};return{schema:m.OBSERVATION_SCHEMA,readOnly:true,capturedAt:now,providers:['https://base-rpc.publicnode.com','https://base-mainnet.public.blastapi.io'].map(url=>({url,chainId:8453,block:{...b},reads:{}}))};}
test('well-formed common header accepted',()=>assert.equal(m.observationReader(obs(),now).block.number,'53217000'));
for(const value of ['not-a-time','9007199254740993'])test('malformed or unsafe pinned timestamp refused: '+value,()=>{const o=obs();o.providers.forEach(p=>p.block.timestamp=value);assert.throws(()=>m.observationReader(o,now));});
test('missing pinned timestamp refused',()=>{const o=obs();o.providers.forEach(p=>delete p.block.timestamp);assert.throws(()=>m.observationReader(o,now));});
test('unlisted sequencer grace weakening refused',()=>{const a='0x'+'11'.repeat(20);const f={oracle:a,sequencer:{address:a,graceSec:0},changesFromReviewedObservation:[]};const old={oracle:{address:a},sequencer:{address:a,graceSec:3600}};assert.throws(()=>m.feeSubstitutions(f,old),e=>e.code==='unapproved_substitution');});
test('same sequencer grace requires no change',()=>{const a='0x'+'11'.repeat(20);assert.deepEqual(m.feeSubstitutions({oracle:a,sequencer:{address:a,graceSec:3600},changesFromReviewedObservation:[]},{oracle:{address:a},sequencer:{address:a,graceSec:3600}}),[]);});
