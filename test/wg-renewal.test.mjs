// Circuit grant renewal (network/wg-circuit-runtime.mjs renewGrants, network/wg-grants.mjs): a renewal no provider
// answered is retried while the grants last; a provider's refusal, or grants about to run out, closes the circuit.
import test from 'node:test';import assert from 'node:assert/strict';
import {renewGrants} from '../network/wg-circuit-runtime.mjs';
import {WgGrants} from '../network/wg-grants.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const unanswered=()=>Object.assign(new Error('exit provider 1.2.3.4: no answer (ECONNRESET)'),{unanswered:true,providerRole:'public'});

test('an unanswered renewal is retried, and the circuit lives on when the next one is answered',async()=>{
 let calls=0;const log=[];
 const r=renewGrants({every:40,until:Date.now()+10000,closed:()=>false,
  renew:async()=>{calls++;if(calls===1)throw unanswered();return Date.now()+10000;},
  retrying:e=>log.push('retry '+e.message),refused:e=>log.push('refused '+e.message)});
 await wait(40+10+20);r.cancel();
 assert.equal(calls,2,'retried after a quarter of the interval, before the next renewal was due');
 assert.deepEqual(log,['retry exit provider 1.2.3.4: no answer (ECONNRESET)']);
});

test('a provider refusal closes at once, and unanswered renewals close once the grants are nearly gone',async()=>{
 const refusedNow=[];
 const a=renewGrants({every:20,until:Date.now()+10000,closed:()=>false,
  renew:async()=>{throw Object.assign(new Error('guard provider 1.2.3.4: lease ended'),{providerRole:'guard'});},
  retrying:()=>assert.fail('a refusal is never retried'),refused:e=>refusedNow.push(e.providerRole)});
 await wait(40);a.cancel();
 assert.deepEqual(refusedNow,['guard']);

 const log=[];
 const b=renewGrants({every:40,until:Date.now()+60,closed:()=>false,
  renew:async()=>{throw unanswered();},retrying:()=>log.push('retry'),refused:()=>log.push('refused')});
 await wait(80);b.cancel();
 assert.deepEqual(log,['refused'],'20 ms of grant left is not enough for a 10 ms retry and its margin');
});

test('a closed circuit stops renewing',async()=>{
 let calls=0,closed=false;
 const r=renewGrants({every:15,until:Date.now()+10000,closed:()=>closed,renew:async()=>{calls++;closed=true;return Date.now()+10000;},
  retrying:()=>{},refused:()=>assert.fail()});
 await wait(60);r.cancel();
 assert.equal(calls,1);
});

test('a request no provider answered is marked unanswered with its cause; an answer is not',async()=>{
 const account={signMessage:async()=>'0x'};
 const provider={providerId:'p',address:'1.2.3.4'};
 const reset=new WgGrants({account,runner:'r',fetch:async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}});}});
 await assert.rejects(reset.request({provider,url:'http://x',role:'exit',deploymentId:'0x1',wgPublicKey:'k'}),
  e=>e.unanswered===true&&e.providerRole==='public'&&/exit provider 1\.2\.3\.4: no answer \(ECONNRESET\)/.test(e.message));
 const answered=new WgGrants({account,runner:'r',fetch:async()=>new Response(JSON.stringify({error:'lease ended'}),{status:403})});
 await assert.rejects(answered.request({provider,url:'http://x',role:'guard',deploymentId:'0x1',wgPublicKey:'k'}),
  e=>!e.unanswered&&e.refused===true&&/lease ended/.test(e.message));
});
