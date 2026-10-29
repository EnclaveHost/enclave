// Actual policy predicate used at Host's final legacy-send boundaries. No transaction, Host send or network execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {ENROLLMENT_SCHEMA,enrolledByPolicy,enrollmentState,TEST_resetProtectedComposition} from './candidate/control/windows/node/protected-supervisor.mjs';
const id='0x'+'aa'.repeat(32),neighbor='0x'+'bb'.repeat(32);
function fixture(t){
 TEST_resetProtectedComposition();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'policy-refresh-'));
 const file=path.join(dir,'policy.json');
 const bytes=Buffer.from(JSON.stringify({schema:ENROLLMENT_SCHEMA,host:'0x'+'cc'.repeat(32),manager:'http://127.0.0.1:41',controlKeyFile:path.join(dir,'TEST-key'),deployments:[id],stagingMs:30000}));
 fs.writeFileSync(file,bytes);
 const env={ENCLAVE_PROTECTED_ENROLLMENT:file,ENCLAVE_PROTECTED_ENROLLMENT_SHA256:createHash('sha256').update(bytes).digest('hex')};
 t.after(()=>{TEST_resetProtectedComposition();fs.rmSync(dir,{recursive:true,force:true});});
 assert.equal(enrolledByPolicy(id,env),true);assert.equal(enrolledByPolicy(neighbor,env),false);assert.equal(enrollmentState(env),'valid');
 return {file,env};
}
test('ROOT positive: initially corrupt pinned policy refuses legacy classification',t=>{
 const {file,env}=fixture(t);fs.writeFileSync(file,'{}');TEST_resetProtectedComposition();
 assert.equal(enrolledByPolicy(neighbor,env),undefined);assert.equal(enrollmentState(env),'unknown');
});
test('ROOT post-await boundary predicate must notice corruption after first successful policy read',t=>{
 const {file,env}=fixture(t);fs.writeFileSync(file,'{}');
 assert.equal(enrolledByPolicy(neighbor,env),undefined,'cached valid enrollment must not authorize legacy send after policy becomes hash-mismatched');
});
test('ROOT post-await boundary predicate must notice missing policy after first successful read',t=>{
 const {file,env}=fixture(t);fs.unlinkSync(file);
 assert.equal(enrollmentState(env),'unknown','missing policy must not remain valid in the final-send predicate');
});
