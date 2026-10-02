import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

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
    const operation=this.tail.then(async()=>{
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
    this.tail=operation.catch(()=>{});return operation;
  }
  set(key,value) {return this.update(key,()=>value);}
}
