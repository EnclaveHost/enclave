// rememberVerified (network/owner-signature.mjs): a verification that succeeded is not repeated for ten minutes, so an
// agent's refresh round does not read the chain for every directory's copy of one signed policy.
import test from 'node:test';import assert from 'node:assert/strict';
import {rememberVerified} from '../network/owner-signature.mjs';

test('a yes is kept for the time given and for that owner, message and signature only; a no is asked again',async()=>{
 let clock=1_000_000,calls=[];let answer=true;
 const verify=rememberVerified(async(o,m,s)=>{calls.push([o,m,s].join('/'));return answer;},{now:()=>clock,ttlMs:600_000});
 assert.equal(await verify('0xAbC','policy 1','0x01'),true);
 for(let i=0;i<5;i++)assert.equal(await verify('0xabc','policy 1','0x01'),true);     // (the owner's case does not matter)
 assert.equal(calls.length,1);
 assert.equal(await verify('0xabc','policy 2','0x01'),true);assert.equal(await verify('0xabc','policy 1','0x02'),true);assert.equal(await verify('0xdef','policy 1','0x01'),true);
 assert.equal(calls.length,4);
 clock+=599_999;assert.equal(await verify('0xabc','policy 1','0x01'),true);assert.equal(calls.length,4);
 // past the time it is asked again, and a no then is a no at once
 clock+=2;answer=false;assert.equal(await verify('0xabc','policy 1','0x01'),false);assert.equal(calls.length,5);
 assert.equal(await verify('0xabc','policy 1','0x01'),false);assert.equal(calls.length,6);
 answer=true;assert.equal(await verify('0xabc','policy 1','0x01'),true);assert.equal(await verify('0xabc','policy 1','0x01'),true);assert.equal(calls.length,7);
 // anything but true is a no
 const odd=rememberVerified(async()=>1);assert.equal(await odd('0x1','m','0x'),false);
});

test('the same question asked while it is being answered is asked once; a failure reaches every asker and is not kept',async()=>{
 let n=0,release;const gate=new Promise(r=>{release=r;});
 const verify=rememberVerified(async()=>{n++;await gate;return true;});
 const all=Promise.all([verify('0x1','m','0x2'),verify('0x1','m','0x2'),verify('0x1','m','0x2')]);
 release();assert.deepEqual(await all,[true,true,true]);assert.equal(n,1);
 let fail=true;const flaky=rememberVerified(async()=>{if(fail)throw Error('chain unreachable');return true;});
 await assert.rejects(Promise.all([flaky('0x1','m','0x2'),flaky('0x1','m','0x2')]),/chain unreachable/);
 fail=false;assert.equal(await flaky('0x1','m','0x2'),true);
});

test('no more than `max` answers are kept',async()=>{
 let n=0;const verify=rememberVerified(async()=>{n++;return true;},{max:2});
 await verify('0x1','a','0x');await verify('0x1','b','0x');await verify('0x1','c','0x');assert.equal(n,3);
 await verify('0x1','c','0x');await verify('0x1','b','0x');assert.equal(n,3);
 await verify('0x1','a','0x');assert.equal(n,4);
});
