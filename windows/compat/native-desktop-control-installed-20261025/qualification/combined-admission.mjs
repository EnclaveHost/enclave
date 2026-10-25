// A harmless fixture admission worker, never the production node agent.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const ready=JSON.parse(fs.readFileSync(path.join(root,'Shield.ready.json')));
process.kill(ready.pid,0);
const h=await (await fetch('http://127.0.0.1:'+ready.port+'/health')).json();
if(h.managerEpoch!==ready.epoch || !h.canStart || h.inventory.state!=='ready' || (ready.native && !h.desktop?.ready))throw Error('fixture manager not ready');
for(const [name,value] of [['admit.json',{epoch:ready.epoch}],['Node.ready.json',{pid:process.pid,epoch:ready.epoch,started:new Date().toISOString()}]]){
  const file=path.join(root,name);fs.writeFileSync(file+'.tmp',JSON.stringify(value));fs.renameSync(file+'.tmp',file);
}
setInterval(()=>{},1000);
