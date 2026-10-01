import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEnvelope,isolationForBackend} from '../windows/node/chain.mjs';
const SNP='snp-guest-per-app',HV='hyperv-partition-per-app';
test('unspecified hardware requirements select isolated execution on either implementation',()=>{
 for(const raw of ['', '{}', '{"isolation":{"cpuTee":false,"gpuTee":false}}']) {
  const o=parseEnvelope(raw);
  assert.equal(isolationForBackend(o,SNP),true);assert.equal(isolationForBackend(o,HV),true);
  assert.equal(isolationForBackend(o,null),false);
 }
});
test('CPU and GPU requirements fail closed against current capabilities',()=>{
 const cpu=parseEnvelope('{"isolation":{"cpuTee":true}}');
 assert.equal(isolationForBackend(cpu,SNP),true);assert.equal(isolationForBackend(cpu,HV),false);
 for(const backend of [SNP,HV]) assert.equal(isolationForBackend(parseEnvelope('{"isolation":{"gpuTee":true}}'),backend),false);
 for(const raw of ['{"isolation":{"cpuTee":1}}','{"isolation":{"gpuTee":"false"}}','{"isolation":[]}']) assert.throws(()=>parseEnvelope(raw));
});
test('legacy explicit backend requirements remain enforced until the owner changes them',()=>{
 assert.equal(isolationForBackend(parseEnvelope('{"isolation":{"require":"snp-guest-per-app"}}'),HV),false);
 assert.equal(isolationForBackend(parseEnvelope('{"isolation":{"require":"hyperv-partition-per-app"}}'),SNP),false);
});
