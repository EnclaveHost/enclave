import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {captureGenesis} from '../driver/genesis-capture.mjs';import {readRecoveryGenesis} from '../driver/read-steps.mjs';import {R2,METAL0_REGISTRY_ID} from '../driver/plan.mjs';
test('pre-recovery chain reconciliation binds the original capture and learned committee without claiming a new quote',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'custody-recovery-genesis-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const h=x=>'0x'+x.repeat(32),endpoint='https://custody-canary.example',machine={identity:'0x'+'12'.repeat(20),encKey:h('34'),endpoint,chipId:h('56'),registryId:METAL0_REGISTRY_ID,measurement:R2.measurementSha256};
 const request={fn:'createCommittee',args:[h('78'),machine,'0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',[R2.measurementSha256],'0x'+'00'.repeat(65),'0x'+'00'.repeat(65)]};
 const capture=captureGenesis({dir,endpoint,body:Buffer.from(JSON.stringify(request))});assert.equal(capture.status,503);let calls=0;const committeeId=h('90');
 const args={dir,endpoint,captureDigest:capture.digest,committeeId,pins:{owner:{address:'0x'+'11'.repeat(20)},vaultCodeHash:h('ab')},verifyCommittee:async opts=>{calls++;assert.deepEqual(opts.expectedMachine,machine);return {outcome:'pass',evidence:{deploymentId:committeeId}};}};
 const r=await readRecoveryGenesis(args);assert.match(r.evidence.scope,/Not fresh attestation/);assert.equal(calls,1);
 await assert.rejects(()=>readRecoveryGenesis({...args,captureDigest:'f'.repeat(64)}),/unavailable or conflicting/);assert.equal(calls,1);
 await assert.rejects(()=>readRecoveryGenesis({...args,committeeId:h('91')}),/unavailable or conflicting/);
 fs.writeFileSync(path.join(dir,'genesis-request.json'),'{synthetic-private-value');await assert.rejects(()=>readRecoveryGenesis(args),e=>!e.message.includes('synthetic-private'));
});
