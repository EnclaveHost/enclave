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
test('a config override is judged by the hosts that could claim the deployment, not the fleet-wide AND', async () => {
 const { hostsTakeConfig } = await import('../site/js/core/isolation-options.js');
 // the live fleet on 2026-10-16: metal0 says false on purpose (release path), the other two take it themselves
 const metal0={id:'m',availability:{claimEnabled:true,isolation:SNP,configOverride:false,configCidOverride:true}};
 const nuc={id:'n',availability:{claimEnabled:true,isolation:SHIELD,configOverride:true,configCidOverride:true}};
 const pvm={id:'p',availability:{claimEnabled:true,isolation:'avf-pvm-per-app',configOverride:true,configCidOverride:true}};
 const fleet=[metal0,nuc,pvm];
 for (const raw of ['','{}','{"isolation":{"require":"snp-guest-per-app"}}','{"isolation":{"cpuTee":false,"gpuTee":false}}'])
  assert.equal(hostsTakeConfig(fleet,raw),true,raw);
 assert.equal(hostsTakeConfig(fleet,'','configCidOverride'),true);
 // an old non-isolation runner that predates the namespace still blocks an unpinned deployment...
 const old={id:'o',availability:{claimEnabled:true,configOverride:false}};
 assert.equal(hostsTakeConfig([...fleet,old],''),false);
 // ...but not one that requires a tier it can't serve
 assert.equal(hostsTakeConfig([...fleet,old],'{"isolation":{"require":"hyperv-partition-per-app"}}'),true);
 // a host that is not claiming, or a relay, is no candidate
 assert.equal(hostsTakeConfig([...fleet,{...old,availability:{...old.availability,claimEnabled:false}},{...old,relay:true}],''),true);
 // inline-only host blocks a pinned override; no candidates or a bad envelope fail closed
 assert.equal(hostsTakeConfig([{id:'i',availability:{claimEnabled:true,configOverride:true}}],'','configCidOverride'),false);
 assert.equal(hostsTakeConfig([],''),false);
 assert.equal(hostsTakeConfig(null,''),false);
 assert.equal(hostsTakeConfig(fleet,'{"isolation":{"unknown":true}}'),false);
 assert.equal(hostsTakeConfig(fleet,'{"isolation":{"gpuTee":true}}'),false);
});
