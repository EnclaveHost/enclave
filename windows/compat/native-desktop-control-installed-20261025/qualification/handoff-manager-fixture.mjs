// Actual pinned Manager/HTTP implementation with an in-memory Hyper-V boundary.
// This process cannot touch Windows tasks, real VMs, wallets or production APIs.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [source,pin,planPath,scenario]=process.argv.slice(2);
if(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')!==pin)throw Error('manager source drift');
const {Manager,createServer}=await import(pathToFileURL(source).href);
const plan=JSON.parse(fs.readFileSync(planPath));
const vms=new Set(plan.targets.map(r=>r.vmId));
const stopped=[];
const manager=new Manager({backend:{canStart:false,canSurvey:false,stop:async h=>{
  if(scenario==='stop-failed')throw Error('fixture host refused removal');
  stopped.push(h.vmId);if(scenario!=='host-still-present')vms.delete(h.vmId);
}},ramPoolMiB:98304,cpuPoolVcpus:16});
manager.epoch=plan.managerEpoch;
manager.inventory={state:'ready',recovered:0,unattributed:0};
for(const target of plan.targets){
  const {vmId,...row}=target;
  manager.domains.set(row.id,{...row,launcherVmId:vmId,status:'running',appReady:true,handle:{vmId},launching:false});
}
const server=createServer(manager);
await new Promise(r=>server.listen(0,'127.0.0.1',r));
console.log(JSON.stringify({port:server.address().port,pid:process.pid}));
let pending='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',s=>{pending+=s;for(;;){const n=pending.indexOf('\n');if(n<0)break;const cmd=pending.slice(0,n).replace(/\r$/,'');pending=pending.slice(n+1);
  if(cmd==='inventory')console.log(JSON.stringify({vms:[...vms],stopped}));
  else if(cmd==='shutdown'){server.close(()=>process.exit(0));server.closeAllConnections();}
  else throw Error('unknown fixture command');
}});
process.stdin.on('end',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
setTimeout(()=>{server.closeAllConnections();process.exit(2);},30000).unref();
