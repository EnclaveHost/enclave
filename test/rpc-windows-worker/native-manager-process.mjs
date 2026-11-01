// Disposable Windows CI: real manager/client/native processes, inert asset refusal.
// No target admission, tasks, provider, VM, network, wallet or retry.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {performance} from 'node:perf_hooks';
import {createNativeRPCController,invokeNativeProcess} from '../../windows/vbslike/manager/rpc-native-controller.mjs';
import {Manager} from '../../windows/vbslike/manager/server.mjs';
import {canonical,COMPONENT_PREAMBLE,sha256Hex} from '../../windows/vbslike/manager/derive.mjs';
import {deriveRPC,RPC_CONFIG,RPC_PORTS} from '../../windows/vbslike/manager/rpc-derive.mjs';
const root=process.argv[2],info=JSON.parse(fs.readFileSync(path.join(root,'fixture.json'))),H=c=>c.repeat(64);let count=0;
const read=p=>JSON.parse(fs.readFileSync(p)),pass=s=>{count++;console.log('PASS '+s);};
function options(n){const configPath=path.join(root,n,'config.json');return {executable:info.executable,executableSha256:info.executableSha256,configPath,configSha256:sha256Hex(fs.readFileSync(configPath))};}
const opts=options('manager'),cfg=read(opts.configPath),component=Buffer.from(COMPONENT_PREAMBLE);
const record={derivation:'enclave-catalog-bundle/9',catalog:{app:'0x'+H('a'),version:0},cid:'b'+'a'.repeat(58),runtimeId:H('b'),policy:{cpuPercent:400,memMiB:19456,vcpus:4},http:8000,ports:[...RPC_PORTS],configBase64:canonical(RPC_CONFIG).toString('base64'),secretDeployment:'0x'+H('c'),rpc:{profile:'ethereum-base-rpc-v1',profileSha256:H('d'),l1VolumeId:H('e'),baseVolumeId:H('f')}};
const body={id:'rpc'+'1'.repeat(32),name:record.secretDeployment,derive:record,cpuShare:.25,hasSecrets:true,isPublic:true,firewall:[...RPC_PORTS]};
// Only host inventory/component and shared-pool endpoints are fixture inputs.
// The actual manager, client, native CLI, protected file code and clocks run.
let acquired=0,consumed=0,ordinary=0;
function manager(controller){return new Manager({rpcController:controller,backend:{canSurvey:true,survey:async()=>({vms:[]}),preflight:async()=>({ok:true,hostLogicalProcessors:16,checks:[]}),start:async()=>{ordinary++;throw Error('No ordinary launcher');}},ramPoolMiB:77824,cpuPoolVcpus:16,physicalRamPoolMiB:20480,physicalReservations:{poolHash:H('1'),boot:info.boot,acquire:async()=>{acquired++;},consumeStart:async()=>{consumed++;}},fetchComponent:async()=>component});}
const c=await createNativeRPCController(opts),m=manager(c);await m.probe();await m.recover();
const pending=m.spawn(body);assert.equal(m.physicalRamAllocated(),20480);const r=await pending;
assert.equal(r.status,'failed');assert.match(r.reason,/native command failed/);assert.equal(acquired,1);assert.equal(consumed,1);assert.equal(ordinary,0);
const original=read(path.join(cfg.ledgerRoot,'attempt.json')),digest=sha256Hex(fs.readFileSync(path.join(cfg.ledgerRoot,'attempt.json'))),sent=read(path.join(cfg.ledgerRoot,'transport','begin.result.json'));
assert.equal(sent.sha256,digest);assert.equal(original.managerEpoch,m.epoch);assert.equal(original.instance,body.id);assert.equal(BigInt(original.deadlineMs)-BigInt(original.originMs),900000n);
const derived=deriveRPC({record,component});assert.deepEqual(fs.readFileSync(path.join(cfg.ledgerRoot,'inputs','bundle.bin')),derived.bundle);assert.equal(read(path.join(cfg.ledgerRoot,'stage-ready.json')).original,digest);
assert.ok(fs.existsSync(path.join(cfg.ledgerRoot,'define-request.json')));assert.ok(fs.existsSync(path.join(cfg.ledgerRoot,'transport','define.intent.json')));assert.ok(!fs.existsSync(path.join(cfg.ledgerRoot,'transport','define.result.json')));
const attempt=path.join(cfg.attemptsRoot,original.attempt);assert.ok(fs.existsSync(path.join(attempt,'admission.json')));assert.ok(!fs.existsSync(path.join(attempt,'runtime.igvm')));assert.ok(!fs.existsSync(path.join(cfg.ledgerRoot,'dispatch.json')));assert.deepEqual(fs.readdirSync(cfg.workersRoot),[]);
pass('real Manager -> native begin/stage/define consumes exact bytes and refuses missing inert firmware before any dispatch');
const current=await invokeNativeProcess(opts.executable,['current',opts.configPath,opts.configSha256,digest],[]);assert.equal(current.value.original.originMs,original.originMs);assert.ok(BigInt(current.value.nowMs)>=BigInt(original.originMs));assert.equal(current.reservationMayRelease,false);
await assert.rejects(m.spawn(body),/already held|capacity/);assert.equal(m.physicalRamAllocated(),20480);assert.equal(m.get(body.id).reservationMayRelease,false);
pass('actual native QPC receipt and original manager reservation survive definition refusal without replay');
const recovered=await createNativeRPCController(opts),m2=manager(recovered);await m2.probe();await m2.recover();assert.equal(m2.get(body.id).originalManagerEpoch,m.epoch);assert.equal(m2.memoryView().known,false);assert.equal(m2.physicalRamAllocated(),null);await assert.rejects(m2.remove(body.id),/association missing/);await assert.rejects(recovered.begin({managerEpoch:m2.epoch,id:body.id,instanceId:body.id,name:body.name}),/held/);
pass('real native inspect reconstructs held inventory and manager closes new-work admission without adoption');
await assert.rejects(m.remove(body.id),/settlement/);assert.ok(fs.existsSync(path.join(cfg.ledgerRoot,'hold.json')));await assert.rejects(invokeNativeProcess(opts.executable,['current',opts.configPath,opts.configSha256,digest],[]),/failed/);assert.equal(m.physicalRamAllocated(),20480);
pass('real original hold closes mutation but retains reservation');
const blocked=options('blocked'),bcfg=read(blocked.configPath),bc=await createNativeRPCController(blocked);await bc.begin({managerEpoch:'a'.repeat(32),id:'rpc'+'2'.repeat(32),instanceId:'rpc'+'2'.repeat(32),name:'0x'+H('c')});
const bh=sha256Hex(fs.readFileSync(path.join(bcfg.ledgerRoot,'attempt.json'))),started=performance.now();
const child=spawn(blocked.executable,['stage',blocked.configPath,blocked.configSha256,bh],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
let output=0;for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b.length;assert.ok(output<=65536);});child.stdin.on('error',()=>{});
await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
const fd=fs.openSync(path.join(root,'blocked.pid.pending'),'wx');fs.writeFileSync(fd,String(child.pid));fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(path.join(root,'blocked.pid.pending'),path.join(root,'blocked.pid'));
// Deliberately never write/end stdin and never ask Node to kill this process.
// The external C# fixture preholds its exact handle before the native30s expiry.
const ended=await new Promise((resolve,reject)=>{child.once('close',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
const elapsed=performance.now()-started;assert.equal(ended.code,125);assert.equal(ended.signal,null);assert.ok(elapsed>=29000&&elapsed<35000);assert.equal(output,0);assert.ok(fs.existsSync(path.join(bcfg.ledgerRoot,'stage.json')));assert.ok(!fs.existsSync(path.join(bcfg.ledgerRoot,'stage-ready.json')));assert.ok(!fs.existsSync(path.join(bcfg.ledgerRoot,'dispatch.json')));
pass('blocked stdin ends by native independent30s watchdog with exit125 and no ready/dispatch');
console.log(JSON.stringify({schema:'native-manager-process-ci/1',tests:count,blockedPid:child.pid,blockedElapsedMs:elapsed,nativeDeadlineExit:ended.code,rpcReady:false,providerExecuted:false,reservationMayRelease:false}));
console.log('TOTAL '+count+' PASS; actual Windows manager/client/native CLI; fixture inventory/pool; no SYSTEM task/provider/VM');
