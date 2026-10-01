import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
function parse(values,backend='snp-guest-per-app') {
 const out=execFileSync(process.execPath,['supervisor.js'],{env:{...process.env,SECRET:'test',ISOLATION_BACKEND:backend,ISOLATION_SELFTEST:JSON.stringify({parse:values}),REGISTRY_ENABLED:'',CLAIM_ENABLED:''},encoding:'utf8'});
 return JSON.parse(out.trim().split('\n').at(-1)).parse;
}
test('unspecified and unchecked CPU/GPU requirements resolve to the measured isolated backend',()=>{
 for(const backend of ['snp-guest-per-app','hyperv-partition-per-app']) {
  const r=parse(['','{}','{"isolation":{"cpuTee":false,"gpuTee":false}}'],backend);
  for(const p of r){assert.equal(p.ok,true);assert.equal(p.opts.isolation,backend);}
 }
});
test('TEE CPU accepts SNP and rejects Shield; TEE GPU rejects masked offload',()=>{
 assert.equal(parse(['{"isolation":{"cpuTee":true}}'])[0].ok,true);
 assert.equal(parse(['{"isolation":{"cpuTee":true}}'],'hyperv-partition-per-app')[0].ok,false);
 for(const backend of ['snp-guest-per-app','hyperv-partition-per-app']) {
  const r=parse(['{"isolation":{"gpuTee":true}}','{"isolation":{"cpuTee":"false"}}'],backend);
  assert.equal(r[0].ok,false);assert.match(r[0].error,/TEE GPU/);assert.equal(r[1].ok,false);
 }
});
test('a non-isolated runner refuses portable requirements rather than falling back to shared execution',()=>{
 const r=parse(['{"isolation":{"cpuTee":false,"gpuTee":false}}'],'');
 assert.equal(r[0].ok,false);
});
