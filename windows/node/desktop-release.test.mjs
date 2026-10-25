import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { desktopReleaseFromEnv, MAX_DESKTOP_RELEASE_BYTES } from './desktop-release.mjs';
const v = JSON.parse(fs.readFileSync(new URL('../../isolation/contract/catalog/desktop_vectors.json', import.meta.url))).ok.find(x=>x.name==='baseline');
const release = () => ({schema:'enclave-desktop-release/1',controllerCid:v.record.cid,
 controllerSha256:v.mapping.componentSha256,runtimeId:v.record.runtimeId,profileSha256:v.record.desktop.profileSha256,
 igvmSha256:'55'.repeat(32),launchMeasurement:'66'.repeat(32),minimumCpuMilli:250,policy:{cpuPercent:800,vcpus:8}});
function fixture(t, bytes=Buffer.from(JSON.stringify(release()))) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-release-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'release.json');fs.writeFileSync(file,bytes);
 return {ENCLAVE_DESKTOP_RELEASE_FILE:file,ENCLAVE_DESKTOP_RELEASE_SHA256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
test('absent release is disabled; both path and hash are required',()=>{
 assert.equal(desktopReleaseFromEnv({}),null);assert.equal(desktopReleaseFromEnv({ENCLAVE_DESKTOP_RELEASE_FILE:'',ENCLAVE_DESKTOP_RELEASE_SHA256:''}),null);
 for(const env of [{ENCLAVE_DESKTOP_RELEASE_FILE:'release.json'},{ENCLAVE_DESKTOP_RELEASE_SHA256:'a'.repeat(64)},
  {ENCLAVE_DESKTOP_RELEASE_FILE:'release.json',ENCLAVE_DESKTOP_RELEASE_SHA256:'A'.repeat(64)},
  {ENCLAVE_DESKTOP_RELEASE_FILE:'release.json',ENCLAVE_DESKTOP_RELEASE_SHA256:'0'.repeat(64)}]) assert.throws(()=>desktopReleaseFromEnv(env));
});
test('exact bytes produce immutable copied pins and later file edits cannot change them',t=>{
 const env=fixture(t);const got=desktopReleaseFromEnv(env);assert.deepEqual(got,release());assert.ok(Object.isFrozen(got));assert.ok(Object.isFrozen(got.policy));
 fs.writeFileSync(env.ENCLAVE_DESKTOP_RELEASE_FILE,'{}');assert.deepEqual(got,release());assert.throws(()=>desktopReleaseFromEnv(env),/SHA-256 mismatch/);
});
test('re-encoded same JSON is refused when raw-byte pin differs',t=>{
 const env=fixture(t);fs.writeFileSync(env.ENCLAVE_DESKTOP_RELEASE_FILE,JSON.stringify(release(),null,2));assert.throws(()=>desktopReleaseFromEnv(env),/SHA-256 mismatch/);
});
test('bounded regular file, UTF-8, JSON and release schema are independently required',t=>{
 for(const bytes of [Buffer.alloc(0),Buffer.alloc(MAX_DESKTOP_RELEASE_BYTES+1,32),Buffer.from([0xff]),Buffer.from('{'),Buffer.from('{}'),Buffer.from(JSON.stringify({...release(),runtimeId:'0'.repeat(64)}))]) {
  assert.throws(()=>desktopReleaseFromEnv(fixture(t,bytes)));
 }
 const env=fixture(t);fs.unlinkSync(env.ENCLAVE_DESKTOP_RELEASE_FILE);fs.mkdirSync(env.ENCLAVE_DESKTOP_RELEASE_FILE);
 assert.throws(()=>desktopReleaseFromEnv(env));
});
test('maximum-size valid file succeeds and no unpinned fallback is allowed',t=>{
 const data=Buffer.from(JSON.stringify(release()));const bytes=Buffer.concat([data,Buffer.alloc(MAX_DESKTOP_RELEASE_BYTES-data.length,32)]);
 assert.deepEqual(desktopReleaseFromEnv(fixture(t,bytes)),release());
 const env=fixture(t);fs.unlinkSync(env.ENCLAVE_DESKTOP_RELEASE_FILE);assert.throws(()=>desktopReleaseFromEnv(env),/ENOENT/);
});

import { desktopAdoptionRefusal } from './desktop-release.mjs';
import { canonical, sha256Hex } from '../../relay/shield-derive.mjs';
const plan = () => ({derivation:v.record.derivation,spawn:{derive:structuredClone(v.record)}});
const view = () => ({name:v.record.secretDeployment,derivation:v.record.derivation,
 recordSha256:sha256Hex(canonical(v.record)),componentSha256:v.mapping.componentSha256,
 runtimeId:v.record.runtimeId,imageRole:'desktop',igvmSha256:'55'.repeat(32),image:'55'.repeat(32),
 desktop:structuredClone(v.record.desktop)});
test('native adoption requires exact planned record, component, role and image pins',()=>{
 assert.equal(desktopAdoptionRefusal(view(),plan(),release()),null);
 for(const key of ['name','derivation','recordSha256','componentSha256','runtimeId','imageRole','igvmSha256','image']) {
  for(const value of [undefined,null,'wrong']) {
   const x=view();x[key]=value;assert.match(desktopAdoptionRefusal(x,plan(),release()),new RegExp(key));
  }
 }
 for(const key of ['profile','profileSha256','gpuMilli']) {
  const x=view();delete x.desktop[key];assert.match(desktopAdoptionRefusal(x,plan(),release()),new RegExp(key));
 }
 assert.match(desktopAdoptionRefusal(null,plan(),release()),/no manager view/);
});
test('same catalog with different config or resource record cannot be adopted',()=>{
 for(const change of [r=>{r.configBase64=Buffer.from('{"egress":"public-web","codec":"other"}').toString('base64');},
  r=>{r.policy.memMiB+=1024;},r=>{r.desktop.gpuMilli=500;}]) {
  const p=plan();change(p.spawn.derive);assert.match(desktopAdoptionRefusal(view(),p,release()),/recordSha256/);
 }
});
test('invalid native plans fail closed; unrelated plans retain their existing checks',()=>{
 assert.match(desktopAdoptionRefusal(view(),plan(),null),/no valid/);
 const p=plan();p.spawn.derive.runtimeId='88'.repeat(32);assert.match(desktopAdoptionRefusal(view(),p,release()),/differs/);
 assert.equal(desktopAdoptionRefusal(null,{derivation:'enclave-catalog-bundle/1'},null),null);
});
