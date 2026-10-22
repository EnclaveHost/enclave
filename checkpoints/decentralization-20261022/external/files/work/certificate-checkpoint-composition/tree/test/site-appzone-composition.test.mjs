import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import * as sdk from '../sdk/bootstrap/package.mjs';

globalThis.localStorage ??= {getItem:()=>null,setItem(){},removeItem(){}};
globalThis.sessionStorage ??= globalThis.localStorage;
globalThis.location ??= {hostname:'localhost'};
const site = await import('../site/js/core/startup-package.js');
const read = name => JSON.parse(fs.readFileSync(new URL('../isolation/m2/bootstrap/testdata/'+name+'-vectors.json',import.meta.url)));
const intent = bytes => ({version:1,sha256:createHash('sha256').update(bytes).digest('hex')});

for (const name of ['appzone','names','history']) {
  test('browser and SDK preserve all shared '+name+' acceptance and refusal vectors',async()=>{
    const cases=read(name).cases;
    assert.ok(cases.some(c=>c.valid)&&cases.some(c=>!c.valid));
    for (const c of cases) {
      const bytes=Buffer.from(c.manifest);
      let browserError, sdkError;
      try { await site.verifyPackage(bytes,intent(bytes)); } catch(e) {browserError=e;}
      try { sdk.verifyPackage(bytes,intent(bytes)); } catch(e) {sdkError=e;}
      assert.equal(!browserError,c.valid,c.name+': '+(browserError?.message||'accepted'));
      assert.equal(!sdkError,c.valid,c.name+': SDK changed');
    }
  });
}

test('app-zone-only and combined custom-name packages round-trip with checkpoint mirrors',async()=>{
  const zones=read('appzone').cases.filter(c=>c.valid).map(c=>JSON.parse(c.manifest)).filter(m=>m.names?.appZone);
  const history={checkpoints:['https://mirror-a.example/checkpoint','https://mirror-b.example/checkpoint']};
  assert.ok(zones.some(m=>!m.names.hosts));
  for (const manifest of zones) {
    const m={...manifest,history};
    const scope=Object.fromEntries(['chainId','ledger','deployment','owner','appRef'].map(k=>[k,m[k]]));
    const browser=await site.preparePackage(scope,{appId:m.appId,runtimeId:m.runtimeId,configText:m.configText,custody:m.custody??null,names:m.names,history});
    assert.equal(Buffer.from(browser.bytes).toString(),sdk.preparePackage(m).bytes.toString());
    assert.deepEqual(browser.manifest.names,m.names);
    assert.deepEqual(browser.manifest.history,history);
    const a=m.names.acme??{}, z=m.names.appZone;
    const form=site.namesFromForm({hostsText:(m.names.hosts??[]).join('\n'),directory:a.directory,challenge:a.challenge,zone:a.zone,eabKid:a.eab?.kid,eabHmac:a.eab?.hmac,
      appZoneDirectory:z.directory,appZoneChallengesText:[...z.challenges].reverse().join('\n'),appZoneEabKid:z.eab?.kid,appZoneEabHmac:z.eab?.hmac},m.secretsMode);
    assert.deepEqual(form,m.names,'form preserves both custom and app-zone certificate settings');
  }
});

test('app-zone form is explicit, rejects partial settings and never includes EAB values',()=>{
  assert.equal(site.namesFromForm({},'public'),null);
  for (const form of [{appZoneDirectory:'https://ca.example/directory'},{appZoneChallengesText:'https://challenge.example'},
    {appZoneEabKid:'CA_ACCOUNT'},{appZoneDirectory:'https://ca.example/directory',appZoneChallengesText:'http://insecure.example'}])
    assert.throws(()=>site.namesFromForm(form,'public'));
  const form={appZoneDirectory:'https://ca.example/directory',appZoneChallengesText:'https://challenge.example',appZoneEabKid:'CA_ACCOUNT',appZoneEabHmac:'CA_HMAC'};
  assert.throws(()=>site.namesFromForm(form,'public'),/custody-v2/);
  assert.deepEqual(site.namesFromForm(form,'custody-v2').appZone.eab,{kid:'CA_ACCOUNT',hmac:'CA_HMAC'});
});
