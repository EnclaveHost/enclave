import fs from 'node:fs';
import { setup,id,pending } from './owned-host-services-fixture.mjs';
const f=await setup();await f.service.runtime.ensureStaged(id,f.queued);await f.service.runtime.serve(id,f.running);
if(process.argv[2]==='replacement')f.vm={...f.vm,id:'foreign-replacement'};
else f.boundaries.hold=async deployment=>({deployment,ingress:false,storage:true,secrets:true});
const result=await f.service.close('fault qualification');
await Promise.all(f.witnesses.map(w=>w.close()));
const disk=JSON.parse(fs.readFileSync(f.file,'utf8'));
// Only public fixture receipts cross IPC. The failed owner remains held in this process.
process.send({dir:f.dir,file:f.file,released:result.released,fenced:result.fenced,
 pending:disk.deployments.find(row=>row.id===id).pending,foreignRemoved:f.removed.includes('foreign-replacement')});
setInterval(()=>{},1000);
