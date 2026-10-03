import fs from 'node:fs/promises';import path from 'node:path';
const encode=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
// A single-process daemon owns the directory lock for its whole lifetime.
// Stale locks are never guessed away; an operator checks the process first.
export async function openStore(directory) {
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const lock=path.join(directory,'.lock');await fs.mkdir(lock,{mode:0o700});
 await fs.writeFile(path.join(lock,'owner'),String(process.pid)+'\n',{mode:0o600});
 const file=id=>{if(!/^0x[0-9a-f]{64}$/.test(id))throw new Error('invalid job id');return path.join(directory,id+'.json');};
 const write=async(id,value)=>{const target=file(id),temp=target+'.tmp';
  const handle=await fs.open(temp,'w',0o600);try{await handle.writeFile(encode(value));await handle.sync();}finally{await handle.close();}
  await fs.rename(temp,target);const dir=await fs.open(directory,'r');try{await dir.sync();}finally{await dir.close();}
 };
 const get=async id=>{try{return JSON.parse(await fs.readFile(file(id),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
 let pending=Promise.resolve();
 const serial=fn=>{const result=pending.then(fn);pending=result.catch(()=>{});return result;};
 return {get,
  create:job=>serial(async()=>{if(await get(job.id))throw new Error('job exists');await write(job.id,job);return job;}),
  transition:(id,state,patch)=>serial(async()=>{const old=await get(id);if(!old||old.state!==state)throw new Error('state conflict');
   const next={...old,...patch,id:old.id};await write(id,next);return next;}),
  list:async()=>{const ids=(await fs.readdir(directory)).filter(x=>/^0x[0-9a-f]{64}\.json$/.test(x));return Promise.all(ids.map(x=>get(x.slice(0,-5))));},
  close:async()=>{await pending;await fs.rm(lock,{recursive:true});}
 };
}
