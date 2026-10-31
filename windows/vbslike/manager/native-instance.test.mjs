import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { nativeInstanceFromBytes, loadNativeInstance, bindNativeInstance } from './native-instance.mjs';
import { DESKTOP_DERIVATION } from './desktop-derive.mjs';
import { desktopVmMemMiB, NATIVE_24G_MEMORY_PROFILE } from './desktop-memory.mjs';
const H = c => c.repeat(64);
const pins = { deployment: '0x'+H('1'), catalogApp: '0x'+H('2'), catalogVersion: 0,
  cid: 'bafkreifixture', runtimeId: H('3'), profileSha256: H('4') };
const options = { port: 8095, dataPort: 8096, prefix: 'enclave-native-' };
const encode = p => Buffer.from(JSON.stringify({nativePins:p}));
const digest = b => createHash('sha256').update(b).digest('hex');
const make = p => { const b=encode(p);return nativeInstanceFromBytes(b,digest(b),options); };
function body() { return {name:pins.deployment,id:'nd'+'a'.repeat(32),cpuShare:.25,gpuShare:.5,
  derive:{derivation:DESKTOP_DERIVATION,catalog:{app:pins.catalogApp,version:0},cid:pins.cid,runtimeId:pins.runtimeId,
    secretDeployment:pins.deployment,desktop:{profileSha256:pins.profileSha256,gpuMilli:500}}}; }

test('native instance preserves exact installed version zero pins and scope',()=>{
  const input={...pins}, instance=make(input);input.deployment='0x'+H('f');
  instance.check(body());assert.equal(instance.marker,'enclave-native-vbslike-domain');
  assert.equal(instance.memoryProfile,NATIVE_24G_MEMORY_PROFILE);assert.ok(Object.isFrozen(instance.pins));
});
test('native gate rejects each deployment, content and resource substitution before delegation',()=>{
  const instance=make(pins);let calls=0;
  const manager={health:()=>({canStart:true}),spawn:()=>++calls};bindNativeInstance(manager,instance);
  for(const mutate of [b=>b.name='other',b=>b.id='hv'+'a'.repeat(32),b=>b.cpuShare=.5,b=>b.gpuShare=.25,
    b=>b.derive.derivation='other',b=>b.derive.catalog.app='0x'+H('f'),b=>b.derive.catalog.version=1,
    b=>b.derive.cid='other',b=>b.derive.runtimeId=H('f'),b=>b.derive.secretDeployment='0x'+H('f'),
    b=>b.derive.desktop.profileSha256=H('f'),b=>b.derive.desktop.gpuMilli=1000]) {
    const b=body();mutate(b);assert.throws(()=>manager.spawn(b),{status:400});
  }
  assert.equal(calls,0);assert.equal(manager.spawn(body()),1);
  assert.deepEqual(manager.health().vmScope,{prefix:options.prefix,marker:instance.marker});
});
test('missing pins, hash mismatch, invalid UTF8 and wrong instance placement refuse',()=>{
  for(const key of Object.keys(pins)){const p={...pins};delete p[key];assert.throws(()=>make(p));}
  for(const catalogVersion of [-1,'0',.5])assert.throws(()=>make({...pins,catalogVersion}));
  const b=encode(pins);assert.throws(()=>nativeInstanceFromBytes(b,H('0'),options));
  const bad=Buffer.from([255]);assert.throws(()=>nativeInstanceFromBytes(bad,digest(bad),options));
  for(const patch of [{port:8091},{dataPort:8092},{prefix:'enclave-app-'}])
    assert.throws(()=>nativeInstanceFromBytes(b,digest(b),{...options,...patch}));
  assert.throws(()=>nativeInstanceFromBytes(Buffer.alloc(65537),H('0'),options));
});
test('absent native configuration leaves legacy behavior and partial configuration refuses',()=>{
  assert.equal(loadNativeInstance({},options),null);
  for(const e of [{ENCLAVE_NATIVE_ROUTER_CONFIG:''},{ENCLAVE_NATIVE_ROUTER_CONFIG_SHA256:H('a')}])
    assert.throws(()=>loadNativeInstance(e,options));
  const m={spawn:()=>42,health:()=>({})}, before=m.spawn;bindNativeInstance(m,null);assert.equal(m.spawn,before);
});
test('memory exception is opt-in and exact; default and adjacent allowances are unchanged',()=>{
  assert.equal(desktopVmMemMiB(24576),36864);
  assert.equal(desktopVmMemMiB(24576,NATIVE_24G_MEMORY_PROFILE),32768);
  for(const app of [8192,24575,24577,65536])
    assert.equal(desktopVmMemMiB(app,NATIVE_24G_MEMORY_PROFILE),desktopVmMemMiB(app));
  assert.throws(()=>desktopVmMemMiB(24576,'unknown'));
});
