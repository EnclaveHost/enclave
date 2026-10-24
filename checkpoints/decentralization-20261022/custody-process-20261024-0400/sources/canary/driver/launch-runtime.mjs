// Root-operated canary supervisor. Only its timestamped transient unit can be started or stopped.
// This is process/resource evidence, NOT SNP/ingress evidence and never marks G.launch complete.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {canonical,sha256hex} from './canonical.mjs';
import {verifyLaunchBundle} from './launch-bundle.mjs';
import {validateCaptureDirectory} from './genesis-capture.mjs';
const MiB=1024*1024;
export const PROTECTED_UNITS=Object.freeze(['enclave-custodian-v2.service','enclave-guestd.service','enclave-metal.service']);
export const LIMITS=Object.freeze({memoryMax:5120*MiB,swapMax:0,tasksMax:64,runtimeSec:1800,stopSec:15,floorMiB:16384,recipientMiB:2048});
const need=(ok,m)=>{if(!ok)throw Error('canary runtime refused: '+m);};
const unitOf=run=>{need(/^\d{8}T\d{6}Z$/.test(run??''),'timestamped run required');return `enclave-custody-r2-${run}.service`;};
const hash=v=>sha256hex(canonical(v));
const props=['LoadState','ActiveState','SubState','MainPID','InvocationID','ControlGroup','MemoryMax','MemorySwapMax','TasksMax','KillMode','Restart','RuntimeMaxUSec','TimeoutStopUSec','OOMPolicy','WorkingDirectory'];
function syncDir(p){const fd=fs.openSync(p,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function save(file,obj){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(obj,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(path.dirname(file));}
function load(file){const s=fs.lstatSync(file);need(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o600&&s.size<1048576,'private bounded runtime record required');return JSON.parse(fs.readFileSync(file,'utf8'));}
function processIdentity(pid) {
 need(Number.isSafeInteger(pid)&&pid>1,'invalid PID');
 const base='/proc/'+pid,stat=fs.readFileSync(base+'/stat','utf8'),tail=stat.slice(stat.lastIndexOf(')')+2).split(' ');
 need(!['Z','X'].includes(tail[0]),'process is not live');
 const args=fs.readFileSync(base+'/cmdline');
 return {pid,ppid:Number(tail[1]),startTicks:tail[19],exe:fs.readlinkSync(base+'/exe'),argsHash:sha256hex(args),
  cgroup:fs.readFileSync(base+'/cgroup','utf8').trim(),uid:fs.statSync(base).uid};
}
export function linuxRuntimeIO() {
 const command=(bin,args)=>{try{return execFileSync(bin,args,{encoding:'utf8',timeout:20000,maxBuffer:262144,stdio:['ignore','pipe','pipe']});}catch(e){if(bin==='/usr/bin/systemctl'&&args.includes('show')&&e.status===1&&/^LoadState=not-found$/m.test(String(e.stdout)))return String(e.stdout);throw Error('canary runtime command unavailable or outcome uncertain');}};
 const unit=name=>Object.fromEntries(command('/usr/bin/systemctl',['--user','show',name,...props.map(p=>'--property='+p)]).trim().split('\n').filter(x=>x.includes('=')).map(x=>{const n=x.indexOf('=');return [x.slice(0,n),x.slice(n+1)];}));
 const qemuInventory=()=>{
  const qemus=[];
  for(const p of fs.readdirSync('/proc')) {
   if(!/^\d+$/.test(p))continue;
   let comm;try{comm=fs.readFileSync('/proc/'+p+'/comm','utf8');}catch(e){if(e.code==='ENOENT')continue;throw Error('process inventory unavailable');}
   if(!comm.startsWith('qemu'))continue;
   qemus.push(processIdentity(Number(p))); // a disappearing VM makes this census uncertain, not silently absent
  }
  return qemus.sort((a,b)=>a.pid-b.pid);
 };
 const snapshot=()=>{
  const qemus=qemuInventory();
  const units={};for(const name of PROTECTED_UNITS){const u=unit(name);need(u.ActiveState==='active'&&u.SubState==='running','protected service is not running');units[name]={invocation:u.InvocationID,main:processIdentity(Number(u.MainPID))};}
  const mem=fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
  need(mem,'MemAvailable unavailable');
  return {at:Date.now(),bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),memAvailableMiB:Math.floor(Number(mem[1])/1024),units,qemus:qemus.sort((a,b)=>a.pid-b.pid)};
 };
 const listeners=()=>{
  const out=[];
  for(const kind of ['tcp','tcp6'])for(const line of fs.readFileSync('/proc/net/'+kind,'utf8').trim().split('\n').slice(1)) {
   const f=line.trim().split(/\s+/);if(f[3]!=='0A')continue;
   const [addr,port]=f[1].split(':');out.push({kind,addr,port:parseInt(port,16),inode:f[9]});
  }
  return out;
 };
 return {qemus:qemuInventory,now:()=>Date.now(),snapshot,unit,process:processIdentity,protectedPids:()=>PROTECTED_UNITS.map(n=>Number(unit(n).MainPID)).filter(n=>Number.isSafeInteger(n)&&n>1),
  args:pid=>fs.readFileSync('/proc/'+pid+'/cmdline').toString().split('\0').filter(Boolean),
  env:pid=>fs.readFileSync('/proc/'+pid+'/environ').toString().split('\0').filter(Boolean).sort(),
  sockets:pid=>new Set(fs.readdirSync('/proc/'+pid+'/fd').flatMap(fd=>{try{const s=fs.readlinkSync('/proc/'+pid+'/fd/'+fd).match(/^socket:\[(\d+)\]$/);return s?[s[1]]:[];}catch(e){if(e.code==='ENOENT')return [];throw Error('process socket inventory unavailable');}})),listeners,
  cgroup:group=>{
   need(/^\/[A-Za-z0-9_.@/-]+$/.test(group)&&!group.split('/').includes('..'),'invalid control group');
   const dir=path.join('/sys/fs/cgroup',group);need(fs.realpathSync(dir)===dir,'control group is not canonical');
   const read=n=>fs.readFileSync(path.join(dir,n),'utf8').trim();
   return {memoryMax:read('memory.max'),swapMax:read('memory.swap.max'),tasksMax:read('pids.max'),memoryCurrent:read('memory.current'),
    events:Object.fromEntries(read('memory.events').split('\n').map(l=>l.split(' '))),pids:read('cgroup.procs').split('\n').filter(Boolean).map(Number).sort((a,b)=>a-b)};
  },
  start:args=>command('/usr/bin/systemd-run',args),stop:name=>command('/usr/bin/systemctl',['--user','stop',name])};
}
function freshness(snapshot,now,max=30000){need(Number.isSafeInteger(snapshot?.at)&&now>=snapshot.at&&now-snapshot.at<=max,'runtime inventory expired');}
function sameProtected(before,after) {
 need(before.bootId===after.bootId,'host rebooted');
 need(hash(before.units)===hash(after.units),'protected service identity changed');
 const live=new Map(after.qemus.map(p=>[p.pid,p]));
 for(const p of before.qemus)need(hash(p)===hash(live.get(p.pid)??null),'protected VM disappeared, restarted or changed');
}
function baseCheck(snapshot,now) {
 freshness(snapshot,now);need(snapshot.qemus.length>=3,'protected VM census is incomplete');
 need(Object.keys(snapshot.units).sort().join(',')===[...PROTECTED_UNITS].sort().join(','),'protected service census differs');
 for(const u of Object.values(snapshot.units))need(/^[a-f0-9]{32}$/.test(u.invocation)&&u.main.pid>1,'protected service identity is missing');
 need(snapshot.memAvailableMiB>=LIMITS.floorMiB+LIMITS.memoryMax/MiB+LIMITS.recipientMiB,'insufficient available memory including reserved recipient');
}
function startArgs(name,bundle,launch) {
 const properties={MemoryMax:String(LIMITS.memoryMax),MemorySwapMax:'0',TasksMax:'64',RuntimeMaxSec:'1800',TimeoutStopSec:'15',KillMode:'control-group',Restart:'no',OOMPolicy:'stop',StandardOutput:'null',StandardError:'null',WorkingDirectory:bundle};
 return ['--user','--quiet','--unit='+name,'--service-type=exec',...Object.entries(properties).map(([k,v])=>'--property='+k+'='+v),
  '/usr/bin/env','-i',...Object.entries(launch.environment).map(([k,v])=>k+'='+v),launch.executable,...launch.args];
}
function prepared({pins,bundle,digest,runtimeDir,io}) {
 validateCaptureDirectory(runtimeDir);const rec=load(path.join(runtimeDir,'prepared.json'));
 need(rec.unit===unitOf(pins.runLabel)&&rec.bundle===bundle&&rec.digest===digest,'runtime record does not match launch');
 const {recordHash,...body}=rec;need(recordHash===hash(body),'runtime record changed');
 need(rec.preparedAt===rec.before.at,'runtime baseline time differs');
 return rec;
}
export async function startCanaryRuntime({pins,bundle,digest,runtimeDir,readAuthority,io=linuxRuntimeIO(),verifyBundle=verifyLaunchBundle}) {
 const v=verifyBundle({pins,bundle,expectedDigest:digest,requireFresh:true});
 const name=unitOf(pins.runLabel);need(!fs.existsSync(runtimeDir),'runtime record already exists; inspect original attempt, never start again');
 validateCaptureDirectory(path.dirname(runtimeDir));
 need(io.unit(name).LoadState==='not-found','canary unit already exists');
 const before=io.snapshot();baseCheck(before,io.now());
 need(!io.listeners().some(l=>[pins.launch.hostPort,pins.launch.mgmtPort].includes(l.port)),'canary port already listening');
 const authority=await readAuthority();need(authority?.outcome==='pass'&&authority.evidence?.resolves?.['host.accepted']?.ok===true,'fresh accepted host authority required');
 const ts=authority.evidence.blockTimestamp;need(Number.isSafeInteger(ts)&&ts<=io.now()/1000+10&&ts>=io.now()/1000-120,'host authority expired');
 freshness(before,io.now());
 const after=io.snapshot();baseCheck(after,io.now());sameProtected(before,after);need(after.qemus.length===before.qemus.length,'VM census changed before start');
 need(io.unit(name).LoadState==='not-found'&&!io.listeners().some(l=>[pins.launch.hostPort,pins.launch.mgmtPort].includes(l.port)),'unit or port appeared before start');
 // Re-hash files after potentially slow chain reads and BEFORE the one launch attempt.
 verifyBundle({pins,bundle,expectedDigest:digest,requireFresh:true});freshness(after,io.now());
 const argv=startArgs(name,bundle,v.launch);
 fs.mkdirSync(runtimeDir,{mode:0o700});validateCaptureDirectory(runtimeDir);
 const rec={version:1,unit:name,bundle,digest,preparedAt:after.at,before:after,argv,launch:v.launch,ports:{host:pins.launch.hostPort,management:pins.launch.mgmtPort}};
 rec.recordHash=hash(rec);save(path.join(runtimeDir,'prepared.json'),rec);syncDir(path.dirname(runtimeDir));
 try{io.start(argv);}catch{return {status:'unknown',unit:name,note:'Start outcome uncertain. Inspect this exact unit and original record; never create a replacement launch.'};}
 const u=io.unit(name);checkUnit(u,{unit:name,bundle});
 const main=io.process(Number(u.MainPID));need(main.exe===v.launch.executable&&main.uid===process.getuid()&&main.cgroup==='0::'+u.ControlGroup
  &&hash(io.args(main.pid))===hash([v.launch.executable,...v.launch.args]),'started unit is not the intended host; inspect original attempt');
 save(path.join(runtimeDir,'started.json'),{unit:name,invocation:u.InvocationID,recordHash:rec.recordHash,at:io.now()});
 return {status:'started-unverified',unit:name,note:'One bounded capture-only host start requested. Live resource/process, ingress and SNP checks remain required.'};
}
function checkUnit(u,rec) {
 need(u.ActiveState==='active'&&u.SubState==='running'&&u.LoadState==='loaded','canary unit is not running');
 need(/^[a-f0-9]{32}$/.test(u.InvocationID)&&Number(u.MainPID)>1,'canary unit identity missing');
 need(u.ControlGroup.endsWith('/'+rec.unit)&&!u.ControlGroup.includes('..'),'canary control group differs');
 need(u.MemoryMax===String(LIMITS.memoryMax)&&u.MemorySwapMax==='0'&&u.TasksMax==='64'&&u.KillMode==='control-group'&&u.Restart==='no'&&u.OOMPolicy==='stop'
  &&u.RuntimeMaxUSec==='30min'&&u.TimeoutStopUSec==='15s'&&u.WorkingDirectory===rec.bundle,'unit limits or working directory differ');
}
function checkStarted(runtimeDir,rec,u) {
 const file=path.join(runtimeDir,'started.json');
 if(fs.existsSync(file)){const s=load(file);need(s.unit===rec.unit&&s.recordHash===rec.recordHash&&s.invocation===u.InvocationID,'unit invocation changed; refuse replacement process');}
}
export function inspectCanaryRuntime({pins,bundle,digest,runtimeDir,io=linuxRuntimeIO(),verifyBundle=verifyLaunchBundle}) {
 const rec=prepared({pins,bundle,digest,runtimeDir,io});
 const verified=verifyBundle({pins,bundle,expectedDigest:digest,requireFresh:false});
 need(hash(rec.launch)===hash(verified.launch)&&hash(rec.argv)===hash(startArgs(rec.unit,bundle,verified.launch))
  &&rec.ports.host===pins.launch.hostPort&&rec.ports.management===pins.launch.mgmtPort,'recorded launch inputs differ from verified package');
 const u=io.unit(rec.unit);checkUnit(u,rec);checkStarted(runtimeDir,rec,u);
 const after=io.snapshot();freshness(after,io.now());sameProtected(rec.before,after);
 need(after.memAvailableMiB>=LIMITS.floorMiB+LIMITS.recipientMiB,'available memory floor or recipient reserve breached');
 const host=io.process(Number(u.MainPID));need(host.uid===process.getuid()&&host.exe===rec.launch.executable,'host process executable or owner differs');
 need(hash(io.args(host.pid))===hash([rec.launch.executable,...rec.launch.args]),'host process arguments differ');
 const env=Object.entries(rec.launch.environment).map(([k,v])=>k+'='+v).sort();need(hash(io.env(host.pid))===hash(env),'host inherited an unexpected environment');
 const previous=new Set(rec.before.qemus.map(p=>p.pid)),newVMs=after.qemus.filter(p=>!previous.has(p.pid));
 need(newVMs.length===1,'exactly one new canary VM required');const vm=newVMs[0];
 need(vm.ppid===host.pid&&vm.uid===host.uid&&vm.exe===pins.launch.qemu,'canary VM parent, executable or owner differs');
 need(host.cgroup==='0::'+u.ControlGroup&&vm.cgroup===host.cgroup,'canary process escaped its control group');
 const cfg=JSON.parse(fs.readFileSync(path.join(bundle,'config.json'),'utf8'));
 const args=io.args(vm.pid),cmdline=fs.readFileSync(path.join(cfg.dist,'cmdline'),'utf8').trim();
 const expected=[pins.launch.qemu,'-machine','q35,accel=kvm,confidential-guest-support=cx0,memory-backend=ram0','-cpu','host','-smp','2','-m','3072',
  '-nographic','-no-reboot','-kernel',path.join(cfg.dist,'vmlinuz'),'-initrd',path.join(cfg.dist,'initramfs.cpio.gz'),'-append',cmdline,
  '-fw_cfg',`name=opt/org.enclave.custody,file=${path.join(bundle,'state/fwcfg.json')}`,
  '-netdev',`user,id=net0,hostfwd=tcp:127.0.0.1:${rec.ports.management}-:8787`,
  '-device','virtio-net-pci,netdev=net0,csum=off,gso=off,guest_csum=off,host_tso4=off,host_tso6=off,guest_tso4=off,guest_tso6=off,guest_ecn=off,host_ufo=off,guest_ufo=off',
  '-serial','mon:stdio','-object','memory-backend-memfd,id=ram0,size=3072M,share=true,prealloc=false','-bios',cfg.ovmf,
  '-object','sev-snp-guest,id=cx0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on,sev-device=/dev/sev'];
 need(hash(args)===hash(expected),'VM arguments differ from exact reviewed host launch');
 const cg=io.cgroup(u.ControlGroup);
 need(cg.memoryMax===String(LIMITS.memoryMax)&&cg.swapMax==='0'&&cg.tasksMax==='64'&&/^\d+$/.test(cg.memoryCurrent)&&BigInt(cg.memoryCurrent)<=BigInt(LIMITS.memoryMax),'live cgroup limits differ');
 need(cg.events.oom==='0'&&cg.events.oom_kill==='0','canary encountered an OOM');
 need(hash(cg.pids)===hash([host.pid,vm.pid].sort((a,b)=>a-b)),'unexpected process in canary control group');
 const listeners=io.listeners();for(const [port,pid] of [[rec.ports.host,host.pid],[rec.ports.management,vm.pid]]) {
  const hits=listeners.filter(l=>l.port===port);need(hits.length===1&&hits[0].kind==='tcp'&&hits[0].addr==='0100007F'&&io.sockets(pid).has(hits[0].inode),'port is not exclusive loopback owned by expected process');
 }
 // Snapshot identity is checked again after collection; no success from mixed process generations.
 need(hash(io.process(host.pid))===hash(host)&&hash(io.process(vm.pid))===hash(vm)&&io.unit(rec.unit).InvocationID===u.InvocationID,'process changed during observation');
 freshness(after,io.now());
 const observedFile=path.join(runtimeDir,'observed.json'),identity={unit:rec.unit,invocation:u.InvocationID,host,vm,recordHash:rec.recordHash};
 if(fs.existsSync(observedFile))need(hash(load(observedFile))===hash(identity),'canary process restarted since first verified observation');
 else save(observedFile,identity);
 if(!fs.existsSync(path.join(runtimeDir,'started.json')))save(path.join(runtimeDir,'started.json'),{unit:rec.unit,invocation:u.InvocationID,recordHash:rec.recordHash,at:io.now()});
 return {status:'runtime-verified',unit:rec.unit,invocation:u.InvocationID,at:io.now(),bundleDigest:digest,hostPid:host.pid,guestPid:vm.pid,
  protectedVmCount:rec.before.qemus.length,protectedServicesUnchanged:true,memoryMaxMiB:5120,memorySwapMaxMiB:0,memAvailableMiB:after.memAvailableMiB,
  recipientReserveMiB:2048,loopbackPortsVerified:true,scope:'Host process/resource observations only; does not prove measured execution, public ingress, committee creation or decentralized custody.'};
}
export function stopCanaryRuntime({pins,bundle,digest,runtimeDir,io=linuxRuntimeIO()}) {
 const rec=prepared({pins,bundle,digest,runtimeDir,io}),started=load(path.join(runtimeDir,'started.json'));
 const u=io.unit(rec.unit);
 need(started.unit===rec.unit&&started.recordHash===rec.recordHash&&started.invocation===u.InvocationID,'unit invocation changed; refuse replacement process');
 need(u.ControlGroup.endsWith('/'+rec.unit)&&u.KillMode==='control-group','stop ownership is not confined to this unit');
 const cg=io.cgroup(u.ControlGroup);
 // Preserve every VM live now, including the dedicated recipient created AFTER the original launch baseline.
 // This inventory is independent of protected-service health, so a sick service cannot prevent owned cleanup.
 const liveVms=io.qemus(),group='0::'+u.ControlGroup,owned=liveVms.filter(p=>p.cgroup===group),others=liveVms.filter(p=>p.cgroup!==group);
 need(owned.length<=1&&owned.every(p=>p.ppid===Number(u.MainPID)&&p.exe===pins.launch.qemu&&p.uid===process.getuid()),'unexpected VM in canary control group');
 const allowed=new Set([Number(u.MainPID),...owned.map(p=>p.pid)]);
 need(cg.pids.every(p=>allowed.has(p)),'unexpected process in canary control group');
 const protectedPids=new Set([...rec.before.qemus.map(p=>p.pid),...Object.values(rec.before.units).map(u=>u.main.pid),...io.protectedPids()]);
 need(cg.pids.every(p=>!protectedPids.has(p)),'a protected process is inside the canary control group');
 // Resource, health or file failures must not prevent stopping our confirmed invocation.
 // No killall/process-name/PID-only operation is used.
 need(io.unit(rec.unit).InvocationID===started.invocation,'unit changed before stop');
 io.stop(rec.unit);
 const after=io.unit(rec.unit);need(!['active','activating','deactivating'].includes(after.ActiveState),'canary stop is incomplete');
 const snapshot=io.snapshot();sameProtected(rec.before,snapshot);
 need(hash(snapshot.qemus)===hash(others),'VM census changed during stop, or a canary VM remains');
 return {status:'stopped',unit:rec.unit,protectedServicesUnchanged:true,stateRetained:true,note:'No state or captured intent deleted. Reconcile any genesis send before an explicit recovery launch.'};
}
