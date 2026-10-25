// Real staged Manager/HTTP code; in-memory Hyper-V only. No production endpoints.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [source,pin,inputPath,admissionPath,scenario]=process.argv.slice(2);
if(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')!==pin)throw Error('manager source drift');
const {Manager,createServer}=await import(pathToFileURL(source).href);
const {notesFor}=await import(new URL('./wmi-launcher.mjs',pathToFileURL(source)).href);
const input=JSON.parse(fs.readFileSync(inputPath));
const {platform,runtime}=JSON.parse(fs.readFileSync(admissionPath));
const host=new Map(input.host.map(v=>[v.id,v]));
const stopped=[];
const backend={canStart:false,canSurvey:true,desktopPlatform:platform,
  survey:async()=>({vms:[...host.values()].filter(v=>v.candidate).map(v=>({vmId:v.id,name:v.name,notes:notesFor(v.identity)}))}),
  stop:async h=>{
    if(scenario==='stop-failed')throw Error('fixture stop failed');
    stopped.push(h?.vmId ?? null);
    if(scenario!=='host-still-present' && h?.vmId)host.delete(h.vmId);
    if(scenario==='removed-then-failed')throw Error('fixture bridge cleanup failed after VM removal');
  }};
const manager=new Manager({backend,images:{legacy:{igvmSha256:'a'.repeat(64)},desktop:{platform,runtime}},
  desktopWorker:{ready:true},ramPoolMiB:98304,physicalRamPoolMiB:84992,cpuPoolVcpus:16,
  configEnabled:true,secretsEnabled:true,configSocketServer:true,protectedPorts:true,
  fetchConfig:async()=>{throw Error('no config fetch in removal fixture');},
  egress:{enabled:true,mode:'fixture-deny'},judgeReady:async()=>{throw Error('no launch in removal fixture');}});
manager.epoch=input.epoch;
manager.inventory={state:'ready',recovered:0,unattributed:0};
for(const row of input.records)manager.domains.set(row.id,{...row});
const server=createServer(manager);
await new Promise(r=>server.listen(0,'127.0.0.1',r));
console.log(JSON.stringify({port:server.address().port,pid:process.pid}));
let pending='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',s=>{pending+=s;for(;;){const n=pending.indexOf('\n');if(n<0)break;
  const cmd=pending.slice(0,n).replace(/\r$/,'');pending=pending.slice(n+1);
  if(cmd==='inventory')console.log(JSON.stringify({host:[...host.values()],stopped}));
  else if(cmd==='shutdown'){server.close(()=>process.exit(0));server.closeAllConnections();}
  else throw Error('unknown fixture command');
}});
process.stdin.on('end',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
setTimeout(()=>{server.closeAllConnections();process.exit(2);},30000).unref();
