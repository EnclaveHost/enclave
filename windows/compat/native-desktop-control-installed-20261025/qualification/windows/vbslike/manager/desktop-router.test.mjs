import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DesktopLauncher} from './desktop-router.mjs';
import {ProfileLauncher} from './shield-profile.mjs';
import {DESKTOP_DERIVATION} from './desktop-derive.mjs';
import {HyperVPartitionBackend} from './backend.mjs';
function fixture(){
 const calls=[];
 const make=role=>({boundary:'host-trusted',desktopPlatform:role==='desktop'?{pin:'native'}:null,
  preflight:async()=>({ok:true,checks:[],hostLogicalProcessors:16}),
  start:async(mapping,opts)=>{calls.push({op:'start',role,mapping,opts});return{imageRole:role};},
  stop:async handle=>{calls.push({op:'stop',role,handle});return{stopped:true};},
  survey:async()=>{calls.push({op:'survey',role});return{vms:[]};},
  teardown:async opts=>{calls.push({op:'teardown',role,opts});return{removed:0};}});
 const cpu=make('cpu'),gpu=make('gpu'),desktop=make('desktop'),base=new ProfileLauncher(cpu,gpu);
 return{calls,cpu,gpu,desktop,base,router:new DesktopLauncher(base,desktop)};
}
test('backend routes concurrent ordinary, inference and native requests without changing image selection',async()=>{
 const h=fixture(),b=new HyperVPartitionBackend({launcher:h.router});
 const mappings=[{record:{derivation:7}},{record:{derivation:7,inference:{gpuMilli:100}}},{record:{derivation:DESKTOP_DERIVATION,desktop:{gpuMilli:500}}}];
 const opts={appCpu:{appCpuPercent:600},appMemoryMiB:8192};
 const handles=await Promise.all(mappings.map(m=>b.start(m,opts)));
 assert.deepEqual(h.calls.map(c=>c.role),['cpu','gpu','desktop']);
 h.calls.forEach((c,i)=>{assert.equal(c.mapping,mappings[i]);assert.equal(c.opts,opts);});
 assert.equal(b.desktopPlatform,h.desktop.desktopPlatform);assert.equal(b.boundary,'host-trusted');
 await Promise.all(handles.map(x=>b.stop(x)));
 assert.deepEqual(h.calls.slice(3).map(c=>c.role),['cpu','cpu','desktop']);
});
test('malformed desktop-marked mapping never falls through to an ordinary launcher',async()=>{
 const h=fixture();await h.router.start({record:{derivation:7,desktop:{}}},{});
 assert.equal(h.calls[0].role,'desktop');
});
test('desktop preflight errors disable only desktop; base errors remain failures',async()=>{
 for(const sync of [false,true]){
  const h=fixture();h.desktop.preflight=sync?()=>{throw Error('native unavailable');}:async()=>{throw Error('native unavailable');};
  const p=await h.router.preflight();assert.equal(p.ok,true);assert.equal(p.hostLogicalProcessors,16);assert.equal(p.roles.desktop.ok,false);
  assert.match(p.roles.desktop.checks[0].detail,/native unavailable/);
  h.cpu.preflight=async()=>{throw Error('host unavailable');};await assert.rejects(h.router.preflight(),/host unavailable/);
 }
});
test('shared inventory and teardown retain the base launcher and its options',async()=>{
 const h=fixture(),options={requireMarker:true};h.base.marker='owner';h.base.prefix='enclave-app-';
 assert.equal(h.router.marker,'owner');assert.equal(h.router.prefix,'enclave-app-');
 assert.deepEqual(await h.router.survey(),{vms:[]});
 // Existing ProfileLauncher owns its teardown policy; verify router forwarding directly.
 h.base.teardown=async o=>{assert.equal(o,options);return{removed:0};};
 assert.deepEqual(await h.router.teardown(options),{removed:0});assert.equal(h.calls[0].role,'cpu');
});
test('failed and recovered native handles use native cleanup and propagate uncertainty',async()=>{
 const h=fixture();h.desktop.stop=async handle=>{assert.equal(handle.imageRole,'desktop');throw Error('cleanup uncertain');};
 for(const recovered of [true,false])await assert.rejects(h.router.stop({imageRole:'desktop',vmId:'test',recovered}),/cleanup uncertain/);
 assert.equal(h.calls.length,0);
});
