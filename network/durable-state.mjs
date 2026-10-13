import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

const fileWriters=new Map();

// One process owns each state directory. Instances in that process also share
// a per-file queue, including an old route draining while its replacement starts.
// One writer per state directory. A route sequence or replay floor is committed
// before publication/use, and cannot silently reset after a damaged state file.
// Overwrite a file in place: the new text is padded with spaces to the old length so one write replaces every byte
// (JSON ignores trailing whitespace), and no truncate leaves a moment with the old tail after the new head.
async function overwrite(file,text){
  const handle=await fs.open(file,'r+').catch(e=>{if(e.code==='ENOENT')return fs.open(file,'w',0o600);throw e;});
  try {
    const {size}=await handle.stat(),body=Buffer.from(text);
    const buf=body.length>=size?body:Buffer.concat([body,Buffer.alloc(size-body.length,0x20)]);
    await handle.write(buf,0,buf.length,0);await handle.sync();
  } finally {await handle.close();}
}

export class DurableState {
  // inPlace: when Windows keeps refusing the rename, overwrite the file where it stands instead of failing (only for a
  // short-lived file whose readers re-read a torn copy: the egress routes, egress-map.mjs; see update()).
  constructor(directory,{inPlace=false}={}) {this.directory=directory;this.inPlace=inPlace;this.tail=Promise.resolve();}
  filename(key) {if (!/^[a-zA-Z0-9_-]{1,130}$/.test(key)) throw new Error('invalid state key');return path.join(this.directory,key+'.json');}
  async get(key) {
    try {return JSON.parse(await fs.readFile(this.filename(key),'utf8'));}
    catch(e) {if(e.code==='ENOENT')return null;throw e;}
  }
  update(key,transform) {
    const fileKey=path.resolve(this.filename(key));
    const operation=Promise.all([this.tail,fileWriters.get(fileKey)||Promise.resolve()]).then(async()=>{
      const value=await transform(await this.get(key));
      await fs.mkdir(this.directory,{recursive:true,mode:0o700});
      const file=this.filename(key), temporary=file+'.'+randomBytes(8).toString('hex');
      const handle=await fs.open(temporary,'wx',0o600);
      try {await handle.writeFile(JSON.stringify(value));await handle.sync();} finally {await handle.close();}
      // Windows refuses to replace a file while ANY process has it open (EPERM/EACCES/EBUSY), FILE_SHARE_DELETE or not,
      // and refuses to move the temporary while a virus scanner reads it after its close: shield-egress reads
      // egress-routes.json on every outbound connection of every app, so on the NucBox the rename was refused for
      // seconds at a time (11 refusals in 15 min after 20 retries over 5 s, 2026-10-13). The rename is retried; an
      // inPlace state then overwrites the file where it stands (its readers re-read a torn copy), and a temporary that
      // still cannot land is removed rather than left beside the file.
      for(let attempt=0;;attempt++){
        try {await fs.rename(temporary,file);break;}
        catch(e){
          const busy=['EPERM','EACCES','EBUSY'].includes(e.code);
          if(busy&&this.inPlace&&attempt>=6){await fs.rm(temporary,{force:true}).catch(()=>{});await overwrite(file,JSON.stringify(value));break;}
          if(!busy||attempt>=20){await fs.rm(temporary,{force:true}).catch(()=>{});throw e;}
          await new Promise(r=>setTimeout(r,25*(attempt+1)));
        }
      }
      // Windows cannot open directory handles through Node's fs API.
      if(process.platform!=='win32'){const dir=await fs.open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}}
      return value;
    });
    this.tail=operation.catch(()=>{});const tail=this.tail;fileWriters.set(fileKey,tail);
    void tail.then(()=>{if(fileWriters.get(fileKey)===tail)fileWriters.delete(fileKey);});return operation;
  }
  set(key,value) {return this.update(key,()=>value);}
}
