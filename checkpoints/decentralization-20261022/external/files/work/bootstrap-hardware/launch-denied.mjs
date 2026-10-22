import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const dir=new URL('./',import.meta.url);
try{fs.unlinkSync(new URL('admitted-cid',dir));}catch(e){if(e.code!=='ENOENT')throw e;}
execFileSync(process.execPath,[new URL('manager.mjs',dir).pathname,'launch'],{stdio:'inherit'});
const id=JSON.parse(fs.readFileSync(new URL('launch-response.json',dir))).body.id;
if(!/^db[0-9a-f]+$/.test(id))throw Error('bad lab guest id');
const end=Date.now()+30000;
while(Date.now()<end){
 let text='';try{text=fs.readFileSync(new URL(`guests/${id}/${id}.host`,dir),'utf8');}catch{}
 const m=text.match(/\bcid=(\d+)/);
 if(m){fs.writeFileSync(new URL('admitted-cid',dir),m[1]+'\n',{mode:0o600});console.log(JSON.stringify({id,admittedCID:Number(m[1])}));process.exit(0);}
 await new Promise(r=>setTimeout(r,50));
}
throw Error('test CID was not assigned');
