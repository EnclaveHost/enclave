import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

const fileWriters=new Map();

// One process owns each state directory. Instances in that process also share
// a per-file queue, including an old route draining while its replacement starts.
// One writer per state directory. A route sequence or replay floor is committed
// before publication/use, and cannot silently reset after a damaged state file.
export class DurableState {
  constructor(directory) {this.directory=directory;this.tail=Promise.resolve();}
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
      await fs.rename(temporary,file);
      // Windows cannot open directory handles through Node's fs API.
      if(process.platform!=='win32'){const dir=await fs.open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}}
      return value;
    });
    this.tail=operation.catch(()=>{});const tail=this.tail;fileWriters.set(fileKey,tail);
    void tail.then(()=>{if(fileWriters.get(fileKey)===tail)fileWriters.delete(fileKey);});return operation;
  }
  set(key,value) {return this.update(key,()=>value);}
}
