import fs from 'node:fs/promises';import path from 'node:path';
const encode=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
// A single-process daemon owns the directory lock for its whole lifetime. The lock names its owner: the pid, when that
// process started, and the boot it started in. A lock left by a process that is certainly gone is taken over: one from
// another boot of this machine, or one whose pid no longer exists or belongs to a process started at another time (the
// service was killed with the machine on 2026-11-18 and then failed on its own lock 4,700 times in two days). A lock
// whose owner is running, or cannot be told to be gone, is refused as before.
const bootId=async()=>{try{return (await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();}catch{return null;}};
// field 22 of /proc/<pid>/stat, counted after the last ')' because the command name may hold spaces and brackets
const startOf=async pid=>{try{const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]||null;}catch(e){return e.code==='ENOENT'?'gone':null;}};
export async function lockOwnerGone(lock) {
 let text;try{text=await fs.readFile(path.join(lock,'owner'),'utf8');}catch{return false;}
 const [pid,start,boot]=text.trim().split(/\s+/);if(!/^[1-9][0-9]*$/.test(pid))return false;
 const now=await bootId();if(boot&&now&&boot!==now)return true;
 const running=await startOf(pid);if(running==='gone')return true;
 return Boolean(start&&running&&start!==running);
}
export async function openStore(directory) {
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const lock=path.join(directory,'.lock');
 try{await fs.mkdir(lock,{mode:0o700});}catch(e){
  if(e.code!=='EEXIST'||!await lockOwnerGone(lock))throw e;
  // the rename succeeds for one process only; a second one fails here or at the mkdir
  const stale=`${lock}.stale-${process.pid}`;await fs.rename(lock,stale);await fs.rm(stale,{recursive:true});await fs.mkdir(lock,{mode:0o700});
 }
 await fs.writeFile(path.join(lock,'owner'),[process.pid,await startOf(process.pid)||'',await bootId()||''].join(' ').trim()+'\n',{mode:0o600});
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
