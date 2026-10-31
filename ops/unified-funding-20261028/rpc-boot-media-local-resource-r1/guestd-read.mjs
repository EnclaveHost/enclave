// Authenticated read-only manager status. The handshake creates only a transient
// protocol session. No VM command, private environment, log or pad is requested.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {GuestdControl, parseKey} from './control-client.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
const cfg=JSON.parse(fs.readFileSync(root+'CONFIG.json','utf8'));
const timer=setTimeout(()=>{console.log(JSON.stringify({ok:false,error:'status-deadline',nativeAdmitted:false}));process.exit(2);},18000);
const uint=x=>Number.isSafeInteger(x)&&x>=0;
const budget=x=>{if(!x||!uint(x.memMiB)||!uint(x.cpuPct))throw Error('budget-schema');return {memMiB:x.memMiB,cpuPct:x.cpuPct};};
function pool(x){
  if(!x||!x.host||!uint(x.guests)||typeof x.overcommitted!=='boolean')throw Error('pool-schema');
  for(const k of ['floorMiB','memAvailableMiB','pendingMiB','unreadUnits'])if(!uint(x.host[k]))throw Error('pool-host-unread');
  if(x.host.floorMiB<=0)throw Error('host-floor-disabled');
  return {budget:budget(x.budget),allocated:budget(x.allocated),free:budget(x.free),guests:x.guests,
    overcommitted:x.overcommitted,host:Object.fromEntries(['floorMiB','memAvailableMiB','pendingMiB','unreadUnits'].map(k=>[k,x.host[k]]))};
}
try{
  const stat=fs.statSync(cfg.guestdKeyFile);
  if(!stat.isFile()||stat.size>65||(stat.mode&0o077))throw Error('key-file-policy');
  const key=parseKey(fs.readFileSync(cfg.guestdKeyFile,'utf8'));
  const manager=new GuestdControl(cfg.guestdUrl,key,{handshakeTimeoutMs:2000,requestTimeoutMs:2500,maxResponseBytes:262144,maxHandshakeBytes:16384});
  const get=async path=>{const r=await manager.request('GET',path,undefined,{timeoutMs:2500});if(r.status!==200)throw Error('status-refused');return r.body;};
  const before=await get('/health');if(before.ok!==true)throw Error('health-not-ok');
  const first=pool(before.pool);
  const v=await get('/vms');if(!Array.isArray(v.vms)||v.vms.length>256)throw Error('VM-count-bound');
  const guests=v.vms.map(x=>{
    if(typeof x.id!=='string'||!/^[a-z]{2}[a-f0-9]{8}$/.test(x.id)||typeof x.status!=='string'||x.status.length>32)throw Error('VM-schema');
    return {id:x.id,status:x.status,reserved:x.reserved===undefined?null:budget(x.reserved)};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const after=await get('/health');if(after.ok!==true)throw Error('health-not-ok');const last=pool(after.pool);
  const allocated=guests.reduce((a,x)=>({memMiB:a.memMiB+(x.reserved?.memMiB??0),cpuPct:a.cpuPct+(x.reserved?.cpuPct??0)}),{memMiB:0,cpuPct:0});
  const reservationsStable=JSON.stringify(first.allocated)===JSON.stringify(last.allocated)&&JSON.stringify(allocated)===JSON.stringify(last.allocated)&&first.guests===last.guests;
  key.fill(0);
  console.log(JSON.stringify({ok:true,authenticated:true,readOnly:true,at:Date.now()/1000,before:first,after:last,guests,reservationsStable,
    pendingUpperMiB:Math.max(first.host.pendingMiB,last.host.pendingMiB),memAvailableLowerMiB:Math.min(first.host.memAvailableMiB,last.host.memAvailableMiB),
    rawHealthRetained:false,nativeAdmitted:false}));
}catch(e){console.log(JSON.stringify({ok:false,error:e.kind??e.name??'status-refused',nativeAdmitted:false}));process.exitCode=2;}
finally{clearTimeout(timer);}
