import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyPackage,preparePackage} from '../sdk/bootstrap/package.mjs';
const h=JSON.parse(fs.readFileSync(new URL('../isolation/m2/bootstrap/testdata/history-vectors.json',import.meta.url)));
const z=JSON.parse(fs.readFileSync(new URL('../isolation/m2/bootstrap/testdata/appzone-vectors.json',import.meta.url)));
const intent=b=>({version:1,sha256:createHash('sha256').update(b).digest('hex')});
test('composed certificate SDK preserves every accepted and rejected cold-history vector',()=>{
 assert.ok(h.cases.length>=30);
 for(const c of h.cases){let e;try{verifyPackage(Buffer.from(c.manifest),intent(c.manifest));}catch(x){e=x;}
 assert.equal(!e,c.valid,`${c.name}: ${e?.message??'accepted'}`);}
});
test('one owner package carries both independent history and app-zone issuance without changing either',()=>{
 const histories=h.cases.filter(c=>c.valid).map(c=>JSON.parse(c.manifest)).filter(m=>m.history);
 const zones=z.cases.filter(c=>c.valid).map(c=>JSON.parse(c.manifest)).filter(m=>m.names?.appZone&&!m.names.appZone.eab);
 assert.ok(histories.length>0&&zones.length>0);
 for(const hm of histories)for(const zm of zones){
  const m={...hm,names:zm.names};const p=preparePackage(m);const decoded=verifyPackage(p.bytes,intent(p.bytes));
  assert.deepEqual(decoded.manifest.history,hm.history);assert.deepEqual(decoded.manifest.names,zm.names);
  assert.equal(decoded.sha256,p.sha256);
 }
});
