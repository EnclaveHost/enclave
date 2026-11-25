import {test} from 'node:test';
import assert from 'node:assert/strict';
import {desktopVmMemMiB} from './desktop-memory.mjs';
test('native RAM policy is the app plus a stated reserve over the full profile range',()=>{
 assert.equal(desktopVmMemMiB(8192),10184);
 assert.equal(desktopVmMemMiB(24576),26896);
 assert.equal(desktopVmMemMiB(65536),68676);
 let previous=0;
 for(let app=8192;app<=65536;app++){
  const vm=desktopVmMemMiB(app);
  // the app, the 1792-MiB reserve the rule names, and 2 % on top; never the old half again
  assert.ok(vm>=previous && vm%2===0 && vm>=(app+1792)*1.02 && vm<(app+1792)*1.02+2 && vm<app*1.25);
  previous=vm;
 }
});
test('native RAM rejects ambiguous, undersized and out-of-profile allocations',()=>{
 for(const x of [null,undefined,false,true,'8192',NaN,Infinity,-1,8191,8192.5,65537])
  assert.throws(()=>desktopVmMemMiB(x));
});
