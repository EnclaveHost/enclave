import test from 'node:test';
import assert from 'node:assert/strict';
import { isolationOptions, withIsolationRequirements, hostMeetsTeeRequirements } from '../site/js/core/isolation-options.js';
const SNP = 'snp-guest-per-app', SHIELD = 'hyperv-partition-per-app';
test('checkboxes convert legacy backend pins to independent portable requirements and preserve app options', () => {
 const options={isolation:{require:SNP},configCid:'bafyexample',config:{volumes:['model']},network:{relay:'us-west'},gpu:{optional:true},waf:{rps:10}};
 assert.equal(isolationOptions(JSON.stringify(options)).cpuTee,true);
 for (const cpuTee of [false,true]) for (const gpuTee of [false,true]) {
  const result=JSON.parse(withIsolationRequirements(JSON.stringify(options),{cpuTee,gpuTee}));
  assert.deepEqual(result,{...options,isolation:{cpuTee,gpuTee}});
 }
 assert.equal(isolationOptions(JSON.stringify({isolation:{require:SHIELD}})).cpuTee,false);
});
test('malformed or unknown options are never silently dropped', () => {
 for (const raw of ['null','[]','bafyexample','{broken','{"isolation":[]}','{"isolation":{"cpuTee":"false"}}','{"isolation":{"unknown":true}}'])
  assert.throws(()=>withIsolationRequirements(raw,{cpuTee:false,gpuTee:false}));
 assert.throws(()=>withIsolationRequirements('',{cpuTee:true,gpuTee:false},20),/byte limit/);
});
test('unchecked allows both isolated hosts; CPU excludes Shield; GPU excludes both current masked paths', () => {
 const snp={availability:{isolation:SNP}},shield={availability:{apps:{isolation:SHIELD}}};
 for(const row of [snp,shield]) assert.equal(hostMeetsTeeRequirements(row,{cpuTee:false,gpuTee:false}),true);
 assert.equal(hostMeetsTeeRequirements(snp,{cpuTee:true,gpuTee:false}),true);
 assert.equal(hostMeetsTeeRequirements(shield,{cpuTee:true,gpuTee:false}),false);
 for(const row of [snp,shield,{availability:{gpuTee:true}}]) assert.equal(hostMeetsTeeRequirements(row,{cpuTee:false,gpuTee:true}),false);
 assert.equal(hostMeetsTeeRequirements({},{}),false);
});
