import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cpuForShare,cpuFixedPolicy,validCpuPool} from './cpu-share.mjs';
import {ImageLauncher} from './shield-profile.mjs';
const policy={vcpus:1,cpuPercent:100};
test('purchased CPU share sizes processor count and exact guest quota separately',()=>{
 const c=cpuForShare(16,.21,policy);
 assert.equal(c.vcpus,4);assert.equal(c.entitlementUnits,336000);
 assert.equal(c.limit,84000);assert.equal(c.reservation,84000);assert.equal(c.appCpuPercent,336);
 const shaped=cpuForShare(16,.25,{vcpus:8,cpuPercent:800});
 assert.equal(shaped.vcpus,8);assert.equal(shaped.limit,50000);assert.equal(shaped.appCpuPercent,400);
});
test('fractional shares round down rather than granting extra CPU',()=>{
 const c=cpuForShare(16,.1234567,policy);
 assert.ok(c.grantedUnits<=c.entitlementUnits);
 assert.ok(c.appCpuPercent*1000<=c.entitlementUnits);
 assert.equal(c.appCpuPercent,197);
});
test('invalid pools, shares and unfulfillable catalog floors refuse',()=>{
 for(const n of [0,-1,1.5,1025,NaN,'16'])assert.equal(validCpuPool(n),false);
 for(const share of [0,-1,1.1,NaN,.000001])assert.throws(()=>cpuForShare(16,share,policy));
 assert.throws(()=>cpuForShare(4,.25,{vcpus:8,cpuPercent:800}));
 assert.equal(cpuFixedPolicy(policy,'witness').grantedUnits,100000);
});
for(const desktop of [false,true])test('image composition preserves host CPU observation with desktop='+desktop,async()=>{
 const legacy={preflight:async()=>({ok:true,checks:[],hostLogicalProcessors:16})};
 const direct={imageRole:'shield-direct',preflight:async()=>({ok:true,checks:[]})};
 const native={imageRole:'desktop',start(){},preflight:async()=>({ok:false,checks:[]})};
 const composed=new ImageLauncher({legacy,shieldDirect:direct,desktop:desktop?native:null});
 assert.equal((await composed.preflight()).hostLogicalProcessors,16);
 legacy.preflight=async()=>({ok:false,checks:[]});
 assert.equal((await composed.preflight()).hostLogicalProcessors,null);
});
