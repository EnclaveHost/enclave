import fs from 'node:fs';
import crypto from 'node:crypto';
const id='0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238';
const deadline=setTimeout(()=>process.exit(2),20000);
const out={capturedAt:new Date().toISOString(),readOnly:true,sourceIdentity:[],ports:[]};
for(const name of ['agent.mjs','host.mjs']){
 const file='C:/Program Files/Enclave/control/windows/node/'+name;
 try{const b=fs.readFileSync(file);if(b.length>1048576)throw Error('source bound');out.sourceIdentity.push({file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')});}
 catch(e){out.sourceIdentity.push({file,error:e.code??'source-read-refused'});}
}
const ports=new Set();
for(const file of ['C:/ProgramData/Enclave/node-config.cmd','C:/ProgramData/Enclave/node-config.local.cmd','C:/ProgramData/Enclave/run-node.cmd']){
 try{
  const b=fs.readFileSync(file);if(b.length>65536)throw Error('config size bound');
  for(const line of b.toString('utf8').split(/\r?\n/)){
   const m=line.trim().match(/^@?set\s+"?LOCAL_HTTP_PORT=(\d+)"?\s*$/i);
   if(m){const port=Number(m[1]);if(port>0&&port<65536){ports.add(port);out.ports.push({source:file,port});}}
  }
 }catch(e){out.ports.push({source:file,error:e.code??'config-read-refused'});}
}
async function get(port,route){
 const r=await fetch(`http://127.0.0.1:${port}${route}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(4000)});
 let n=0;const parts=[];for await(const b of r.body){n+=b.length;if(n>262144)throw Error('response bound');parts.push(b);}
 if(!r.ok)return {httpStatus:r.status};
 return {httpStatus:r.status,value:JSON.parse(Buffer.concat(parts).toString('utf8'))};
}
const clean=x=>String(x??'').replace(/https?:\/\/\S+/g,'[URL]').replace(/0x[0-9a-fA-F]{128,}/g,'[long-hex]').slice(0,600);
const row=r=>Object.fromEntries(['id','status','phase','leaseUntil','reason','lastError','updatedAt','lastClaimAt','nextAttemptAt'].filter(k=>r?.[k]!==undefined).map(k=>[k,['reason','lastError'].includes(k)?clean(r[k]):r[k]]));
out.host=[];
if(ports.size!==1)out.hostRefused='single configured LOCAL_HTTP_PORT not established';
else{
 const port=[...ports][0];
 try{
  const r=await get(port,'/v1/host/state');const v=r.value;
  out.host.push({port,httpStatus:r.httpStatus,records:(v?.deployments??[]).filter(x=>x.id?.toLowerCase()===id).map(row),
   leaseReadiness:v?.leaseReadiness?{sequence:v.leaseReadiness.sequence,startedAt:v.leaseReadiness.startedAt,completedAt:v.leaseReadiness.completedAt,inFlight:v.leaseReadiness.inFlight,deployments:(v.leaseReadiness.deployments??[]).filter(x=>x.id?.toLowerCase()===id).map(row)}:null});
 }catch(e){out.host.push({port,error:e.name,code:e.cause?.code??null});}
}
out.managers=[];
for(const port of [8091,8095]){
 try{const r=await get(port,'/vms');out.managers.push({port,httpStatus:r.httpStatus,managerEpoch:r.value?.managerEpoch,matching:(r.value?.vms??[]).filter(x=>x.name?.toLowerCase()===id||x.deployment?.toLowerCase()===id).map(x=>({id:x.id,name:x.name,status:x.status,physicalMemoryMiB:x.physicalMemoryMiB}))});}
 catch(e){out.managers.push({port,error:e.name,code:e.cause?.code??null});}
}
clearTimeout(deadline);console.log(JSON.stringify(out));
