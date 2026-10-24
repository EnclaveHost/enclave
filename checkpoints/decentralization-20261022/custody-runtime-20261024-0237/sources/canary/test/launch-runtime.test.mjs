import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startCanaryRuntime,inspectCanaryRuntime,stopCanaryRuntime,PROTECTED_UNITS,LIMITS} from '../driver/launch-runtime.mjs';
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'custody-runtime-')));t.after(()=>fs.rmSync(root,{recursive:true}));
 const bundle=path.join(root,'bundle'),runtimeDir=path.join(root,'runtime');fs.mkdirSync(bundle,{mode:0o700});
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
 const io={protectedPids:()=>Object.values(units).map(u=>u.main.pid),now:()=>clock,snapshot:()=>({at:clock,bootId:'same-boot',memAvailableMiB:26000,units:structuredClone(units),qemus:structuredClone(started&&!stopped?[...protectedVms,vm]:protectedVms)}),
  unit:n=>{assert.equal(n,unit);return started?{...u,...(stopped?{ActiveState:'inactive',SubState:'dead'}:{})}:{LoadState:'not-found'};},
  process:p=>structuredClone(p===101?host:p===102?vm:protectedVms.find(v=>v.pid===p)),args:p=>p===101?[launch.executable,...launch.args]:[...qargs],
  env:()=>Object.entries(launch.environment).map(([k,v])=>k+'='+v).sort(),sockets:p=>new Set([p===101?'41':'42']),listeners:()=>started&&!stopped?structuredClone(listeners):[],cgroup:()=>structuredClone(cgroup),
  start:args=>{assert.ok(fs.existsSync(runtimeDir+'/prepared.json'));events.push({op:'start',args});started=true;},stop:n=>{events.push({op:'stop',unit:n});stopped=true;}};
 const f={root,bundle,runtimeDir,pins,launch,u,cgroup,host,vm,listeners,units,protectedVms,io,events,qargs,
  digest:'b'.repeat(64),verifyBundle:()=>({launch}),readAuthority:async()=>({outcome:'pass',evidence:{blockTimestamp:1000,resolves:{'host.accepted':{ok:true}}}})};
 f.start=()=>startCanaryRuntime(f);f.inspect=()=>inspectCanaryRuntime(f);f.stop=()=>stopCanaryRuntime(f);f.tick=n=>{clock+=n;};return f;
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
 const h=fixture(t);await h.start();h.cgroup.pids.push(11);assert.throws(h.stop,/protected process/);assert.equal(h.events.length,1);
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
