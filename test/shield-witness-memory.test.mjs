import test from 'node:test';
import assert from 'node:assert/strict';
import {type1VmMemMiB,READINESS_WITNESS_APP_ID} from '../windows/vbslike/manager/wmi-launcher.mjs';
test('512 MiB applies only to the qualified witness identity and policy',()=>{
 const w={name:'shield-readiness-v1',appId:READINESS_WITNESS_APP_ID};
 assert.equal(type1VmMemMiB(256,w),512);
 assert.equal(type1VmMemMiB(256),2048);
 assert.equal(type1VmMemMiB(256,{...w,name:'0x'+'11'.repeat(32)}),2048);
 assert.equal(type1VmMemMiB(256,{...w,appId:'ff'.repeat(32)}),2048);
 assert.equal(type1VmMemMiB(512,w),2048);
 assert.equal(type1VmMemMiB(8192,w),8832);
 assert.throws(()=>type1VmMemMiB('256',w));
});
