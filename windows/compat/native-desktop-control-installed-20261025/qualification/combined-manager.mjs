// Scheduled-task integration fixture: actual Manager/HTTP, simulated admission/Hyper-V.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const read=n=>JSON.parse(fs.readFileSync(path.join(root,n)));
const write=(n,v)=>{const p=path.join(root,n);fs.writeFileSync(p+'.tmp',JSON.stringify(v));fs.renameSync(p+'.tmp',p);};
const settings=read('fixture.json');
const phase=read('phase.json');
const source=path.join(root,'control/windows/vbslike/manager/server.mjs');
const sourceSha=crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
const native=sourceSha===settings.afterSha256;
if(!native && sourceSha!==settings.beforeSha256)throw Error('unrecognized manager source');
if(native){
  for(const [file,hash] of [['ENCLAVE_DESKTOP_CONFIG','ENCLAVE_DESKTOP_CONFIG_SHA256'],['ENCLAVE_DESKTOP_RELEASE_FILE','ENCLAVE_DESKTOP_RELEASE_SHA256']]){
    const p=process.env[file];
    if(!p || !p.startsWith(root+path.sep) || crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==process.env[hash])throw Error('fixture native hook/pin failed');
  }
  if(process.env.NODE_VM_RAM_GB!=='83')throw Error('fixture physical pool differs');
} else if(process.env.ENCLAVE_DESKTOP_CONFIG)throw Error('baseline inherited native environment');
if(phase.failure==='manager-start'){
  write('Shield.failed.json',{pid:process.pid,sourceSha,injected:true});
  throw Error('injected manager start failure before listener');
}
const {Manager,createServer}=await import(pathToFileURL(source));
const {notesFor}=await import(pathToFileURL(path.join(root,'control/windows/vbslike/manager/wmi-launcher.mjs')));
const {platform,runtime}=read('admission.json');
const host=new Map(settings.unrelated.map(v=>[v.id,v]));
const backend={canStart:true,canSurvey:true,desktopPlatform:platform,
  survey:async()=>({vms:[...host.values()].filter(v=>v.candidate).map(v=>({vmId:v.id,name:v.name,notes:notesFor(v.identity)}))}),
  stop:async handle=>{if(handle?.vmId)host.delete(handle.vmId);snapshot();}};
const manager=new Manager({backend,ramPoolMiB:98304,cpuPoolVcpus:16,...(native?{
  physicalRamPoolMiB:84992,images:{legacy:{igvmSha256:'a'.repeat(64)},desktop:{platform,runtime}},
  desktopWorker:{ready:true},configEnabled:true,secretsEnabled:true,configSocketServer:true,protectedPorts:true,
  fetchConfig:async()=>{throw Error('fixture cannot fetch config');},egress:{enabled:true,mode:'fixture-deny'},
  judgeReady:async()=>{throw Error('fixture cannot launch hardware');}}:{})});
manager.inventory={state:'ready',recovered:0,unattributed:0};
manager._preflight={ok:true,roles:{desktop:{ok:true}},fixture:true};
manager.hostLogicalProcessors=16;
function snapshot(){write('host.json',{epoch:manager.epoch,pid:process.pid,host:[...host.values()]});}
snapshot();
const server=createServer(manager);
await new Promise(r=>server.listen(0,'127.0.0.1',r));
write('Shield.ready.json',{pid:process.pid,epoch:manager.epoch,port:server.address().port,native,sourceSha,started:new Date().toISOString()});
let admitted=false;
setInterval(()=>{
  if(admitted || !fs.existsSync(path.join(root,'admit.json')))return;
  const admission=read('admit.json');if(admission.epoch!==manager.epoch)return;
  admitted=true;
  for(let n=0;n<settings.identities.length;n++){
    const template=settings.identities[n],id='hv'+crypto.randomBytes(16).toString('hex'),vmId=crypto.randomUUID();
    const identity={...template,id,instanceId:'fixture-'+id};
    const failed=phase.failure==='partial-launch' && n===0;
    manager.domains.set(id,{...identity,status:failed?'failed':'running',appReady:!failed,launching:false,
      physicalMemoryMiB:4096,cpu:{grantedUnits:100000},gpuMilli:native?250:0,
      ...(failed?{}:{launcherVmId:vmId}),handle:{vmId}});
    host.set(vmId,{id:vmId,name:'enclave-app-'+id,state:'Running',candidate:true,identity});
  }
  snapshot();write('admitted.json',{epoch:manager.epoch,injected:true,failure:phase.failure});
},100);
