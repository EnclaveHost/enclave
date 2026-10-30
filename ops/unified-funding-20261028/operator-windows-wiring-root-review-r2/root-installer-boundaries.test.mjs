// Original four root assertions retained with explicit config/2 + derived-service and migration TEST fixtures.
// External fixtures only changed; frozen product unchanged. No native ACL / service / EXLOCK qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as C from './candidate/control/windows/node/operator-effects-config.mjs';
import * as I from './candidate/control/windows/node/install-operator-effects.mjs';
import {installFixture,testRun,CFG_SDDL,BASY_ONLY_SDDL,SVC,sha,nothingCreated} from './candidate/test/windows-permit/helpers/ow-fixture.mjs';
test('ROOT positive TEST preflight reaches migration evidence without writes',async t=>{
 const s=installFixture(t); const p=await I.planOperatorEffectsInstall(s.input,{TEST:s.TEST});
 assert.ok(p.checks.includes('migration-evidence'));nothingCreated(assert,s);
});
test('ROOT installer must reject service-writable configuration directory',async t=>{
 const s=installFixture(t);s.TEST.run=testRun({stateDir:s.input.stateDir,cfgSddl:CFG_SDDL+`(A;OICI;FA;;;${SVC})`}).run;
 await assert.rejects(I.planOperatorEffectsInstall(s.input,{TEST:s.TEST}),e=>e.code==='StorageUnqualified'&&e.message.includes('config directory ACL'));
 nothingCreated(assert,s);
});
test('ROOT installer must reject config inaccessible to selected service account',async t=>{
 const s=installFixture(t);s.TEST.run=testRun({stateDir:s.input.stateDir,cfgSddl:BASY_ONLY_SDDL}).run;
 await assert.rejects(I.planOperatorEffectsInstall(s.input,{TEST:s.TEST}),e=>e.code==='StorageUnqualified'&&e.message.includes('config directory ACL'));
 nothingCreated(assert,s);
});
test('ROOT release verification must include actual owned-durable-state dependency',async t=>{
 const s=installFixture(t),j=JSON.parse(fs.readFileSync(s.input.releaseManifest));delete j.files['control/network/owned-durable-state.mjs'];
 const b=Buffer.from(JSON.stringify(j));fs.writeFileSync(s.input.releaseManifest,b);s.input.releaseManifestSha256=sha(b);
 await assert.rejects(I.planOperatorEffectsInstall(s.input,{TEST:s.TEST}),e=>e.code==='ReleaseUnpinned'&&e.message.includes('owned-durable-state'));
 nothingCreated(assert,s);
});
test('ROOT existing oversized config is refused before unbounded readFileSync',t=>{
 const s=installFixture(t);fs.mkdirSync(s.input.stateDir);fs.writeFileSync(path.join(s.input.stateDir,C.STORE_NAME),'TEST');
 fs.writeFileSync(s.input.configOut,Buffer.alloc(1024*1024,32));fs.writeFileSync(I.receiptPath(s.input.configOut),'{}');
 let unbounded=0;const io=C.ioOf(s.TEST);io.fsImpl={...fs,readFileSync(f,...args){if(f===s.input.configOut)unbounded++;return fs.readFileSync(f,...args);}};
 const v=I.validateInputs(s.input,io);assert.equal(I.inspectInstall(v,io).state,'incomplete-or-foreign');assert.equal(unbounded,0);
});
