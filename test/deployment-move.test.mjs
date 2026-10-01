import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isolationOptions, withIsolationRequirements} from '../site/js/core/isolation-options.js';
import {moveLeaseLive, prepareDeploymentMove} from '../site/js/core/deployment-move.js';
import {placementMessage,pinnedHost,withPlacementPin} from '../site/js/core/placement-options.js';
const A='0x'+'aa'.repeat(32),B='0x'+'bb'.repeat(32),ZERO='0x'+'00'.repeat(32);
function fixture(overrides={}) {
 let clock=100000, row={owner:'alice',active:true,runner:ZERO,leaseUntil:0,...overrides};
 const calls=[];
 const opts={read:async()=>({...row}),now:()=>clock,sleep:async ms=>{clock+=ms},timeoutMs:5000,
  release:async()=>{calls.push('release');row.runner=ZERO;row.leaseUntil=0},
  resume:async()=>{calls.push('resume');row.active=true}};
 return {opts,calls,get row(){return row},set row(x){row=x},run:()=>prepareDeploymentMove(opts)};
}
test('queued and failed active records need neither a release nor a resume signature',async()=>{
 for(const status of ['queued','failed','unfunded','starting']) {
  const f=fixture({status});assert.equal((await f.run()).active,true);assert.deepEqual(f.calls,[]);
 }
});
test('ended record resumes once; an expired old runner is not treated as a lease',async()=>{
 const f=fixture({active:false,runner:A,leaseUntil:99});
 assert.equal(moveLeaseLive(f.row,100000),false);await f.run();assert.deepEqual(f.calls,['resume']);
});
test('live lease waits for settlement before returning control to the claim-hint flow',async()=>{
 const f=fixture({runner:A,leaseUntil:200});let reads=0;
 f.opts.release=async()=>{f.calls.push('release')};
 f.opts.read=async()=>{if(++reads===4)f.row.runner=ZERO;return {...f.row}};
 await f.run();assert.equal(reads,4);assert.deepEqual(f.calls,['release']);
});
test('suspended deployment releases its live lease before resuming',async()=>{
 const f=fixture({active:false,runner:A,leaseUntil:200});
 await f.run();assert.deepEqual(f.calls,['release','resume']);
});
test('vault-style suspend then release reactivates only after the old lease clears',async()=>{
 const f=fixture({runner:A,leaseUntil:200});let polls=0;
 f.opts.release=async()=>{f.calls.push('suspend');f.row.active=false};
 f.opts.read=async()=>{if(++polls===3)f.row.runner=ZERO;return {...f.row}};
 await f.run();assert.deepEqual(f.calls,['suspend','resume']);assert.equal(polls,4);
});
test('a rejected resume and a failed release abort without continuing',async()=>{
 const f=fixture({active:false});f.opts.resume=async()=>{throw Error('Signature declined')};
 await assert.rejects(f.run(),/Signature declined/);
 const g=fixture({runner:A,leaseUntil:200});g.opts.release=async()=>{throw Error('offline')};
 await assert.rejects(g.run(),/offline/);assert.deepEqual(g.calls,[]);
});
test('ownership changes stop the workflow and claim races do not terminate a new host',async()=>{
 const f=fixture({runner:A,leaseUntil:200});f.opts.release=async()=>{f.row.owner='bob'};
 await assert.rejects(f.run(),/ownership changed/);
 const g=fixture({runner:A,leaseUntil:200});g.opts.release=async()=>{g.calls.push('release');g.row.runner=B};
 assert.equal((await g.run()).runner,B);assert.deepEqual(g.calls,['release']);
});
test('a live lease timeout never resumes or silently queues a second instance',async()=>{
 const f=fixture({runner:A,leaseUntil:200});f.opts.release=async()=>{};
 await assert.rejects(f.run(),/has not cleared/);assert.deepEqual(f.calls,[]);
});

// Exercise the dashboard's real action with the helper wired in. No wallet or
// production requests: the fake ledger changes only after the target hint.
const source=readFileSync(new URL('../site/components/deployments/deployments.js',import.meta.url),'utf8');
const method=source.match(/^  async _doMove\([^]*?^  }/m)[0];
const buildPanel=new Function('Enclave','depGet','ctlOf','prepareDeploymentMove','moveLeaseLive','paintLine',
 'setTimeout','leaseHostOf','connectWallet','ensureBaseChain','sendTx','waitReceipt','encCall','DEP_SEL','DEPLOYMENTS_ADDRESS',
 'isolationOptions','withIsolationRequirements','depSchemaRev','placementMessage','personalSign','pinnedHost','withPlacementPin',
 `return new (class { ${method} })()`);
const makePanel=(...args)=>{ while(args.length<20)args.push(undefined); return buildPanel(...args,pinnedHost,withPlacementPin); };
for (const target of ['nucbox-k11', '']) for (const active of [true, false]) for (const saveRequirements of [false,true]) {
 test(`dashboard Pin ${target || 'Auto'} ${active ? 'queued' : 'ended'} ${saveRequirements ? 'with requirements' : ''} respects resume and target selection`, async()=>{
  let row={owner:'alice',active,runner:ZERO,leaseUntil:0};const hints=[],messages=[],signatures=[];
  const api={provider:true,claimHint:async(id,name,options)=>{
   assert.deepEqual(options,{strategy:target?"preferred":"cheapest"});
   assert.equal(row.active,true);hints.push([id,name]);row={...row,runner:B,leaseUntil:Date.now()/1000+60};return {accepted:true};
  },getEnclaves:async()=>[]};
  const unexpected=()=>{throw Error('unexpected host authentication or lease release')};
  const panel=makePanel(api,async()=>row,()=> 'wallet',prepareDeploymentMove,moveLeaseLive,
   (_el,_style,message)=>messages.push(message),(callback)=>{callback();return 1},()=>({name:'nucbox-k11'}),
   unexpected,async()=>{},async(_address,data)=>{signatures.push(data);return '0xreceipt'},
   async()=>{if(signatures.at(-1)==='resume')row.active=true},(selector,args)=>{if(selector==='options'){assert.deepEqual(JSON.parse(args[1].v),{isolation:{cpuTee:false,gpuTee:false}});return 'requirements';}assert.equal(selector,'activate');assert.equal(args[1].v,true);return 'resume';},
   {setActive:'activate',setConfig:'options'},'ledger',isolationOptions,withIsolationRequirements,async()=>15);
  panel._list=[{id:A}];panel.refresh=()=>{};panel._envLearn=()=>{};
  const box={isConnected:true,querySelector:()=>({}),...(saveRequirements?{_isolationChoice:{cpuTee:false,gpuTee:false,original:JSON.stringify('')}}:{})};const go={textContent:'Pin',disabled:false};
  await panel._doMove(A,target,box,go);
  assert.deepEqual(hints,[[A,target]]);assert.ok(messages.some(m=>m.includes('running on nucbox-k11')));
  assert.deepEqual(signatures,[...(saveRequirements?['requirements']:[]),...(active?[]:['resume'])]);assert.equal(go.disabled,false);
 });
}

test('keeping the selected live host performs no release, resume or claim',async()=>{
 const f=fixture({runner:A,leaseUntil:200});f.opts.keepRunner=A.toUpperCase();
 assert.equal((await f.run()).runner,A);assert.deepEqual(f.calls,[]);
 const g=fixture({runner:A,leaseUntil:200});g.opts.keepRunner=B;
 await g.run();assert.deepEqual(g.calls,['release']);
});

for (const alreadySaved of [false,true]) test(`applying the current host ${alreadySaved ? 'keeps' : 'saves'} preference without stopping the app`,async()=>{
 const row={id:A,owner:'alice',active:true,runner:B,leaseUntil:Date.now()/1000+600,configCid:'{"isolation":{"cpuTee":false,"gpuTee":false}}'};
 const target={name:'nucbox-k11',row:{id:B}},saved=[],signed=[],messages=[];
 const unexpected=()=>{throw Error('keeping the current host must not release, resize, resume or hint')};
 const api={provider:true,getEnclaves:async()=>[target.row],claimHint:unexpected,terminateDeployment:unexpected,
  savePlacement:async(id,body,via)=>{assert.equal(id,A);assert.equal(body.hostId,B);assert.equal(via,false);saved.push(body);return {configured:true,hostId:B,name:target.name};}};
 const panel=makePanel(api,async()=>row,()=> 'wallet',prepareDeploymentMove,moveLeaseLive,
  (_el,_style,message)=>messages.push(message),()=>0,()=>target,unexpected,unexpected,unexpected,unexpected,unexpected,
  {},'ledger',isolationOptions,withIsolationRequirements,async()=>15,placementMessage,async message=>{signed.push(message);return 'signed';});
 panel._list=[{id:A}];panel._envLearn=unexpected;
 const box={isConnected:true,querySelector:()=>({}),_placementTargets:[target],_placement:{configured:alreadySaved,hostId:alreadySaved?B:''},
  _isolationChoice:{cpuTee:false,gpuTee:false,original:JSON.stringify(row.configCid)}};
 const go={textContent:'Apply',disabled:false};
 await panel._doMove(A,target.name,box,go,target.name);
 assert.equal(saved.length,alreadySaved?0:1);assert.equal(signed.length,alreadySaved?0:1);
 assert.ok(messages.some(message=>message.includes('running on nucbox-k11')));
 assert.equal(go.disabled,false);assert.equal(row.runner,B);
});

for(const allowFallback of [false,true]) test(`changing Allow Fallback to ${allowFallback} saves the ledger policy before the preference without restarting the current host`,async()=>{
 const original={isolation:{cpuTee:false,gpuTee:false},config:{setting:'preserved'},...(!allowFallback?{}:{placement:{hostId:B}})};
 const row={id:A,owner:'alice',active:true,runner:B,leaseUntil:Date.now()/1000+600,configCid:JSON.stringify(original)};
 const target={name:'nucbox',row:{id:B}},calls=[];
 const unexpected=()=>{throw Error('the current host must keep running')};
 const api={provider:true,getEnclaves:async()=>[target.row],claimHint:unexpected,terminateDeployment:unexpected,
  savePlacement:async(id,body)=>{
   calls.push('save');assert.equal(body.allowFallback,allowFallback);
   assert.equal(pinnedHost(row.configCid),allowFallback?'':B);
   return {configured:true,hostId:B,allowFallback};
  }};
 const panel=makePanel(api,async()=>row,()=> 'wallet',prepareDeploymentMove,moveLeaseLive,()=>{},()=>0,()=>target,
  unexpected,async()=>{},async(_address,args)=>{calls.push('options');row.configCid=args[1].v;return 'receipt'},async()=>{},(_sel,args)=>args,
  {setConfig:'options'},'ledger',isolationOptions,withIsolationRequirements,async()=>15,placementMessage,async msg=>{assert.match(msg,new RegExp('Allow fallback: '+allowFallback));return 'signed'});
 panel._list=[{id:A}];panel._envLearn=()=>{};
 const box={isConnected:true,querySelector:selector=>selector==='.mv-fallback'?{checked:allowFallback}:{},
  _placementTargets:[target],_placement:{configured:true,hostId:B,allowFallback:!allowFallback},
  _isolationChoice:{cpuTee:false,gpuTee:false,original:JSON.stringify(row.configCid)}};
 await panel._doMove(A,target.name,box,{textContent:'Apply'},target.name);
 assert.deepEqual(calls,['options','save']);assert.deepEqual(JSON.parse(row.configCid).config,original.config);
});
