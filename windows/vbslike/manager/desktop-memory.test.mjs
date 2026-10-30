import {test} from 'node:test';
import assert from 'node:assert/strict';
import {desktopVmMemMiB} from './desktop-memory.mjs';
test('native RAM policy preserves the qualified 8-GiB app / 12-GiB partition and handles full profile range',()=>{
 assert.equal(desktopVmMemMiB(8192),12288);
 assert.equal(desktopVmMemMiB(65536),98304);
 let previous=0;
 for(let app=8192;app<=65536;app++){
  const vm=desktopVmMemMiB(app);
  assert.ok(vm>=previous && vm%2===0 && vm>=app+512);
  previous=vm;
 }
});
test('native RAM rejects ambiguous, undersized and out-of-profile allocations',()=>{
 for(const x of [null,undefined,false,true,'8192',NaN,Infinity,-1,8191,8192.5,65537])
  assert.throws(()=>desktopVmMemMiB(x));
});
