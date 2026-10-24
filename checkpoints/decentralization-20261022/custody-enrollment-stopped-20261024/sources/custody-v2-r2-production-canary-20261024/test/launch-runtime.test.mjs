import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';import {attachCanaryLogs} from '../driver/private-log.mjs';
import {startCanaryRuntime,inspectCanaryRuntime,stopCanaryRuntime,inspectStoppedCanaryRuntime,PROTECTED_UNITS,LIMITS} from '../driver/launch-runtime.mjs';
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'custody-runtime-')));t.after(()=>fs.rmSync(root,{recursive:true}));
 const bundle=path.join(root,'bundle'),runtimeDir=path.join(root,'runtime');fs.mkdirSync(bundle,{mode:0o700});fs.mkdirSync(path.join(bundle,'logs'),{mode:0o700});
 const pins={runLabel:'20261024T030000Z',launch:{hostPort:18970,mgmtPort:18971,qemu:'/fixture/qemu'}};
 const launch={executable:'/fixture/node',args:['--import','file:///fixture/resolver',bundle+'/host.mjs',bundle+'/config.json'],environment:{PATH:'/usr/bin:/bin',CANARY_HOST_COPY_URL:'file:///fixture/host',CANARY_HOST_ORIGINAL_URL:'file:///fixture/original'}};
 const cfg={dist:root+'/dist',ovmf:'/fixture/ovmf'};fs.mkdirSync(cfg.dist);fs.writeFileSync(cfg.dist+'/cmdline','fixture-kernel-arguments');fs.writeFileSync(bundle+'/config.json',JSON.stringify(cfg),{mode:0o600});
 const unit='enclave-custody-r2-'+pins.runLabel+'.service',group='/user.slice/test/'+unit;
 const ident=(pid,ppid=1,exe='/fixture/qemu',cgroup='0::/protected')=>({pid,ppid,exe,cgroup,startTicks:String(pid*10),argsHash:'a'.repeat(64),uid:process.getuid()});
 const protectedVms=[11,12,13].map(p=>ident(p)),units=Object.fromEntries(PROTECTED_UNITS.map((n,i)=>[n,{invocation:String(i+1).repeat(32),main:ident(i+21,1,'/fixture/node')}])) ;
 const host=ident(101,1,launch.executable,'0::'+group),vm=ident(102,101,pins.launch.qemu,'0::'+group);
 let clock=1000000,started=false,stopped=false;const events=[];
 const u={LoadState:'loaded',ActiveState:'active',SubState:'running',MainPID:'101',InvocationID:'a'.repeat(32),ControlGroup:group,MemoryMax:String(LIMITS.memoryMax),MemorySwapMax:'0',TasksMax:'64',KillMode:'control-group',Restart:'no',OOMPolicy:'stop',RuntimeMaxUSec:'30min',TimeoutStopUSec:'15s',WorkingDirectory:bundle};
 const cgroup={memoryMax:String(LIMITS.memoryMax),swapMax:'0',tasksMax:'64',memoryCurrent:'100000',events:{oom:'0',oom_kill:'0'},pids:[101,102]};
 const listeners=[{kind:'tcp',addr:'0100007F',port:18970,inode:'41'},{kind:'tcp',addr:'0100007F',port:18971,inode:'42'}];
 const qargs=['/fixture/qemu','-machine','q35,accel=kvm,confidential-guest-support=cx0,memory-backend=ram0','-cpu','host','-smp','2','-m','3072',
  '-nographic','-no-reboot','-kernel',cfg.dist+'/vmlinuz','-initrd',cfg.dist+'/initramfs.cpio.gz','-append','fixture-kernel-arguments',
  '-fw_cfg',`name=opt/org.enclave.custody,file=${bundle}/state/fwcfg.json`,'-netdev','user,id=net0,hostfwd=tcp:127.0.0.1:18971-:8787',
  '-device','virtio-net-pci,netdev=net0,csum=off,gso=off,guest_csum=off,host_tso4=off,host_tso6=off,guest_tso4=off,guest_tso6=off,guest_ecn=off,host_ufo=off,guest_ufo=off',
  '-serial','mon:stdio','-object','memory-backend-memfd,id=ram0,size=3072M,share=true,prealloc=false','-bios',cfg.ovmf,
  '-object','sev-snp-guest,id=cx0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on,sev-device=/dev/sev'];
 const io={qemus:()=>structuredClone(started&&!stopped?[...protectedVms,vm]:protectedVms).sort((a,b)=>a.pid-b.pid),protectedPids:()=>Object.values(units).map(u=>u.main.pid),now:()=>clock,snapshot:()=>({at:clock,bootId:'same-boot',memAvailableMiB:26000,units:structuredClone(units),qemus:structuredClone(started&&!stopped?[...protectedVms,vm]:protectedVms)}),
  unit:n=>{assert.equal(n,unit);return started?{...u,...(stopped?{ActiveState:'inactive',SubState:'dead',MainPID:'0'}:{})}:{LoadState:'not-found'};},
  generationAlive:()=>started&&!stopped,groupProcesses:()=>started&&!stopped?[101,102]:[],
  process:p=>structuredClone(p===101?host:p===102?vm:protectedVms.find(v=>v.pid===p)),args:p=>p===101?[launch.executable,...launch.args]:[...qargs],
  env:()=>Object.entries(launch.environment).map(([k,v])=>k+'='+v).sort(),sockets:p=>new Set([p===101?'41':'42']),listeners:()=>started&&!stopped?structuredClone(listeners):[],cgroup:()=>structuredClone(cgroup),
  start:args=>{assert.ok(fs.existsSync(runtimeDir+'/prepared.json'));events.push({op:'start',args});started=true;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();attachCanaryLogs(child,{dir:path.join(bundle,'logs'),hostPid:host.pid,hostStartTicks:host.startTicks,onFailure:()=>{throw Error('fixture log failed');}});},stop:n=>{events.push({op:'stop',unit:n});stopped=true;}};
 const f={root,bundle,runtimeDir,pins,launch,u,cgroup,host,vm,listeners,units,protectedVms,io,events,qargs,
  digest:'b'.repeat(64),verifyBundle:()=>({launch}),readAuthority:async()=>({outcome:'pass',evidence:{blockTimestamp:1000,resolves:{'host.accepted':{ok:true}}}})};
 f.start=()=>startCanaryRuntime(f);f.inspect=()=>inspectCanaryRuntime(f);f.stop=()=>stopCanaryRuntime(f);f.inspectStopped=()=>inspectStoppedCanaryRuntime(f);f.tick=n=>{clock+=n;};return f;
}
test('one launch is journaled before effect and actual process/cgroup/socket checks preserve existing VMs',async t=>{
 const f=fixture(t);assert.equal((await f.start()).status,'started-unverified');
 const args=f.events[0].args;assert.ok(args.includes('--property=MemoryMax='+LIMITS.memoryMax));assert.ok(args.includes('--property=MemorySwapMax=0'));assert.ok(args.includes('-i'));assert.ok(args.includes('--property=RuntimeMaxSec=1800'));assert.ok(args.includes('--property=KillMode=control-group'));
 const result=f.inspect();assert.equal(result.status,'runtime-verified');assert.equal(result.protectedVmCount,3);assert.equal(result.loopbackPortsVerified,true);
 await assert.rejects(f.start,/already exists/);assert.equal(f.events.length,1);
 fs.writeFileSync(f.bundle+'/opaque-state','retained');assert.equal(f.stop().status,'stopped');assert.equal(fs.readFileSync(f.bundle+'/opaque-state','utf8'),'retained');assert.equal(f.events[1].unit,result.unit);
});
test('accepted authority, memory, ports, original services and unchanged census gate the first launch',async t=>{
 const cases=[
  f=>{f.readAuthority=async()=>({outcome:'pass',evidence:{blockTimestamp:1000,resolves:{'host.accepted':{ok:false}}}});},
  f=>{f.readAuthority=async()=>({outcome:'pass',evidence:{blockTimestamp:1,resolves:{'host.accepted':{ok:true}}}});},
  f=>{const s=f.io.snapshot;f.io.snapshot=()=>({...s(),memAvailableMiB:22000});},
  f=>{f.io.listeners=()=>[{port:18970}];},
  f=>{delete f.units[PROTECTED_UNITS[0]];},
  f=>{f.readAuthority=async()=>{f.protectedVms[0].startTicks='new';return {outcome:'pass',evidence:{blockTimestamp:1000,resolves:{'host.accepted':{ok:true}}}};};},
  f=>{f.readAuthority=async()=>{f.tick(31000);return {outcome:'pass',evidence:{blockTimestamp:1031,resolves:{'host.accepted':{ok:true}}}};};},
 ];for(const mutate of cases){const f=fixture(t);mutate(f);await assert.rejects(f.start);assert.equal(f.events.length,0);assert.equal(fs.existsSync(f.runtimeDir),false);}
});
test('uncertain start is never repeated; exact live invocation can be reconciled',async t=>{
 const f=fixture(t),start=f.io.start;f.io.start=args=>{start(args);throw Error('uncertain');};assert.equal((await f.start()).status,'unknown');
 assert.equal(fs.existsSync(f.runtimeDir+'/started.json'),false);await assert.rejects(f.start,/already exists/);assert.equal(f.inspect().status,'runtime-verified');assert.equal(fs.existsSync(f.runtimeDir+'/started.json'),true);assert.equal(f.events.length,1);
});
test('unit replacement, escaped or substituted process, unexpected environment and changed tenant all refuse',async t=>{
 const cases=[
  f=>{f.u.InvocationID='c'.repeat(32);},f=>{f.u.MemorySwapMax='max';},f=>{f.u.KillMode='process';},f=>{f.u.RuntimeMaxUSec='infinity';},
  f=>{f.host.exe='/other/node';},f=>{f.host.cgroup='0::/other';},f=>{f.vm.ppid=999;},f=>{f.vm.exe='/other/qemu';},
  f=>{f.io.env=()=>['UNEXPECTED=fixture'];},f=>{f.io.args=()=>['wrong'];},f=>{f.protectedVms[0].startTicks='changed';},f=>{f.units[PROTECTED_UNITS[0]].invocation='b'.repeat(32);},
  f=>{f.qargs[f.qargs.indexOf('-m')+1]='64000';},f=>{f.qargs.push('-m','3072');},f=>{f.qargs.push('-qmp','tcp:0.0.0.0:4444,server,nowait');},f=>{f.qargs[f.qargs.indexOf('-append')+1]='wrong';}
 ];for(const mutate of cases){const f=fixture(t);await f.start();mutate(f);assert.throws(f.inspect);assert.equal(f.events.length,1);}
});
test('kernel-enforced cgroup, OOM, available memory and exact loopback socket ownership are required',async t=>{
 const cases=[f=>{f.cgroup.memoryMax='max';},f=>{f.cgroup.swapMax='1024';},f=>{f.cgroup.tasksMax='max';},f=>{f.cgroup.events.oom_kill='1';},f=>{f.cgroup.pids.push(999);},
  f=>{f.listeners[0].addr='00000000';},f=>{f.listeners.push({...f.listeners[1],kind:'tcp6'});},f=>{f.io.sockets=()=>new Set();},
  f=>{const s=f.io.snapshot;f.io.snapshot=()=>({...s(),memAvailableMiB:18000});}];
 for(const mutate of cases){const f=fixture(t);await f.start();mutate(f);assert.throws(f.inspect);}
});
test('stop works on our unhealthy invocation but refuses replacement or protected process in its cgroup',async t=>{
 const f=fixture(t);await f.start();f.cgroup.events.oom_kill='1';f.io.env=()=>['BROKEN=1'];assert.throws(f.inspect);assert.equal(f.stop().status,'stopped');
 const g=fixture(t);await g.start();g.u.InvocationID='d'.repeat(32);assert.throws(g.stop,/invocation changed/);assert.equal(g.events.length,1);
 const h=fixture(t);await h.start();h.cgroup.pids.push(11);assert.throws(h.stop,/unexpected process|protected process/);assert.equal(h.events.length,1);
});
test('file recheck failure and tampered record cannot authorize start or stop',async t=>{
 const f=fixture(t);let count=0;f.verifyBundle=()=>{if(++count===2)throw Error('changed');return {launch:f.launch};};await assert.rejects(f.start,/changed/);assert.equal(f.events.length,0);
 const g=fixture(t);await g.start();const p=g.runtimeDir+'/prepared.json',rec=JSON.parse(fs.readFileSync(p));rec.unit='enclave-custodian-v2.service';fs.writeFileSync(p,JSON.stringify(rec));assert.throws(g.stop,/does not match/);assert.equal(g.events.length,1);
});

test('reused PID or restarted VM cannot inherit a previous verified observation',async t=>{
 const f=fixture(t);await f.start();f.inspect();f.vm.startTicks='different';assert.throws(f.inspect,/restarted/);assert.equal(f.stop().status,'stopped');
});

test('stop is still attempted when a protected service is unhealthy; it never claims preservation without evidence',async t=>{
 const f=fixture(t);await f.start();f.io.snapshot=()=>{throw Error('protected service unavailable');};
 assert.throws(f.stop,/protected service unavailable/);assert.equal(f.events[1].op,'stop');
});

test('stopping the custodian preserves a later-launched recipient VM, even outside the initial baseline',async t=>{
 const f=fixture(t);await f.start();f.inspect();const recipient={...f.protectedVms[0],pid:301,ppid:300,startTicks:'new-recipient',cgroup:'0::/recipient'};f.protectedVms.push(recipient);
 assert.equal(f.stop().status,'stopped');assert.ok(f.io.qemus().some(p=>p.pid===301));
});
test('stop refuses a recipient or unknown process accidentally sharing the custodian cgroup',async t=>{
 const f=fixture(t);await f.start();f.cgroup.pids.push(300);assert.throws(f.stop,/unexpected process/);assert.equal(f.events.length,1);
 const g=fixture(t);await g.start();const recipient={...g.vm,pid:301,ppid:300};g.protectedVms.push(recipient);g.cgroup.pids.push(301);assert.throws(g.stop,/unexpected VM/);assert.equal(g.events.length,1);
});
test('a later recipient disappearing during stop cannot be reported as preserved',async t=>{
 const f=fixture(t);await f.start();f.protectedVms.push({...f.protectedVms[0],pid:301,startTicks:'recipient'});const stop=f.io.stop;f.io.stop=n=>{stop(n);f.protectedVms.pop();};assert.throws(f.stop,/VM census changed/);assert.equal(f.events[1].op,'stop');
});

test('runtime verification includes private guest-log provenance and rejects substituted capture',async t=>{
 const f=fixture(t);await f.start();const r=f.inspect();assert.equal(r.privateLogs.status,'open');assert.equal(r.privateLogs.hostPid,f.host.pid);
 const p=path.join(f.bundle,'logs','opened.json'),v=JSON.parse(fs.readFileSync(p));v.hostStartTicks='replaced';fs.writeFileSync(p,JSON.stringify(v));assert.throws(f.inspect,/generation/);
});


test('a separately owned recipient is allowed during runtime inspection and counted as protected',async t=>{
 const f=fixture(t);await f.start();f.inspect();f.protectedVms.push({...f.protectedVms[0],pid:301,startTicks:'recipient',cgroup:'0::/recipient'});
 assert.equal(f.inspect().protectedVmCount,4);
});
test('recipient loss during runtime inspection refuses instead of overlooking a later VM',async t=>{
 const f=fixture(t);await f.start();f.protectedVms.push({...f.protectedVms[0],pid:301,startTicks:'recipient',cgroup:'0::/recipient'});
 const read=f.io.snapshot;let n=0;f.io.snapshot=()=>{if(++n===2)f.protectedVms.pop();return read();};assert.throws(f.inspect,/VM disappeared|census changed/);
});
function sealedFixture(f){fs.mkdirSync(f.bundle+'/state',{mode:0o700});fs.writeFileSync(f.bundle+'/state/state.bin',Buffer.alloc(40,7),{mode:0o600});}
test('stopped inspection checks actual absence and retained ciphertext without completing an outage test',async t=>{
 const f=fixture(t);await f.start();f.inspect();sealedFixture(f);f.stop();const v=f.inspectStopped();assert.equal(v.status,'stopped-verified');assert.equal(v.sealedState.bytes,40);assert.equal(v.privateLogs.status,'open');assert.equal(v.portsAbsent,true);assert.equal(v.protectedVmCount,3);assert.match(v.scope,/Not recipient outage refusal/);
 const bytes=fs.readFileSync(f.bundle+'/state/state.bin');assert.deepEqual(bytes,Buffer.alloc(40,7));assert.ok(!JSON.stringify(v).includes(bytes.toString('base64')));
});
test('stopped inspection refuses a still-live generation, member, listener, replacement unit or changed tenant',async t=>{
 const cases=[f=>{f.io.generationAlive=()=>true;},f=>{f.io.groupProcesses=()=>[999];},f=>{f.io.listeners=()=>[{port:18970}];},f=>{f.u.InvocationID='f'.repeat(32);},f=>{f.protectedVms[0].startTicks='replaced';}];
 for(const mutate of cases){const f=fixture(t);await f.start();f.inspect();sealedFixture(f);f.stop();mutate(f);assert.throws(f.inspectStopped);assert.equal(f.events.length,2);}
 const f=fixture(t);await f.start();f.inspect();sealedFixture(f);assert.throws(f.inspectStopped,/not fully stopped/);
});
test('stopped inspection cannot bless missing, linked, public, truncated or changing sealed state',async t=>{
 const cases=[f=>fs.unlinkSync(f.bundle+'/state/state.bin'),f=>fs.chmodSync(f.bundle+'/state/state.bin',0o644),f=>fs.writeFileSync(f.bundle+'/state/state.bin','tiny'),f=>fs.linkSync(f.bundle+'/state/state.bin',f.bundle+'/link'),f=>{const file=f.bundle+'/state/state.bin';fs.renameSync(file,file+'.saved');fs.symlinkSync(file+'.saved',file);},f=>{const read=f.io.snapshot;let n=0;f.io.snapshot=()=>{if(++n===2)fs.writeFileSync(f.bundle+'/state/state.bin',Buffer.alloc(40,9));return read();};}];
 for(const mutate of cases){const f=fixture(t);await f.start();f.inspect();sealedFixture(f);f.stop();mutate(f);assert.throws(f.inspectStopped);}
});
test('stopped inspection requires a prior verified generation and preserves later recipient census',async t=>{
 const f=fixture(t);await f.start();sealedFixture(f);f.stop();assert.throws(f.inspectStopped,/ENOENT/);
 const g=fixture(t);await g.start();g.inspect();sealedFixture(g);g.stop();g.protectedVms.push({...g.protectedVms[0],pid:301,startTicks:'recipient',cgroup:'0::/recipient'});assert.equal(g.inspectStopped().protectedVmCount,4);
 const read=g.io.snapshot;let n=0;g.io.snapshot=()=>{if(++n===2)g.protectedVms.pop();return read();};assert.throws(g.inspectStopped,/VM disappeared|census changed/);
});
