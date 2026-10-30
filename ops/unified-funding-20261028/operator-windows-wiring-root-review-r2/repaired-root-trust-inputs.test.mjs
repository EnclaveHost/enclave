// Actual installer; only Windows observations are TEST responses. No native or financial effects.
import test from 'node:test';import assert from 'node:assert/strict';
import * as I from './repaired/control/windows/node/install-operator-effects.mjs';
import {installFixture,testRun,READ_FILE_SDDL,SVC,nothingCreated} from './repaired/test/windows-permit/helpers/ow-fixture.mjs';
for(const key of ['migrationEvidence','releaseManifest'])test(`ROOT installer refuses service-writable ${key} trust input`,async t=>{
 const s=installFixture(t);const unsafe=READ_FILE_SDDL+`(A;;FA;;;${SVC})`;
 const observation=testRun({stateDir:s.input.stateDir,acl:{[s.input[key]]:unsafe}});s.TEST.run=observation.run;
 await assert.rejects(I.planOperatorEffectsInstall(s.input,{TEST:s.TEST}),e=>e.code==='TrustInputUnsafe');
 nothingCreated(assert,s);
});
