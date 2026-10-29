import test from 'node:test';import assert from 'node:assert/strict';
import {validatePermitConfig} from './candidate/control/windows/vbslike/manager/compose.mjs';
const old={enforcement:{},journal:'/TEST/journal',storage:{},controlKeyFile:'/TEST/key',guard:{},port:8091,dataPort:8092};const entry={role:'general',port:8091,dataPort:8092};
test('ROOT actual entry validator accepts explicit absolute router attestation key while preserving old config',()=>{assert.equal(validatePermitConfig(old,entry),old);const next={...old,routerAttestKeyFile:'/TEST/router.key'};assert.equal(validatePermitConfig(next,entry),next);});
test('ROOT actual entry validator refuses unknown config and relative router key',()=>{assert.throws(()=>validatePermitConfig({...old,untrusted:true},entry));assert.throws(()=>validatePermitConfig({...old,routerAttestKeyFile:'relative'},entry));});
