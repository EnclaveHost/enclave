// Private, finite QEMU stream capture. No guest bytes are returned by inspection or printed.
// A hard stream cap avoids RLIMIT_FSIZE: that process-wide limit also caps QEMU's multi-GiB RAM memfd.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
export const LOG_CAP=4*1024*1024;
const need=(x,m)=>{if(!x)throw Error('canary log refused: '+m);};
const sha=b=>createHash('sha256').update(b).digest('hex');
function directory(dir){const s=fs.lstatSync(dir);need(path.isAbsolute(dir)&&fs.realpathSync(dir)===dir&&s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o700,'private canonical directory required');}
function stat(p){const s=fs.lstatSync(p);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o777)===0o600,'private regular unlinked file required');return s;}
const identity=s=>({dev:s.dev,ino:s.ino});
function writeRecord(dir,name,obj){const fd=fs.openSync(path.join(dir,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,JSON.stringify(obj)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function attachCanaryLogs(child,{dir,onFailure=()=>process.exit(72),hostPid=process.pid,hostStartTicks}={}){
 directory(dir);need(fs.readdirSync(dir).length===0,'log directory is not fresh; never overwrite an earlier generation');
 need(child.stdout&&child.stderr&&typeof child.once==='function','both guest streams required');
 if(hostStartTicks===undefined){const s=fs.readFileSync('/proc/self/stat','utf8');hostStartTicks=s.slice(s.lastIndexOf(')')+2).split(' ')[19];}
 need(Number.isSafeInteger(hostPid)&&hostPid>1&&/^\d+$/.test(hostStartTicks),'host process generation required');
 let total=0,terminal=false;const files={};
 for(const name of ['stdout','stderr']){const p=path.join(dir,name+'.log'),fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);files[name]={fd,bytes:0,...identity(fs.fstatSync(fd))};}
 writeRecord(dir,'opened.json',{version:1,hostPid,hostStartTicks,cap:LOG_CAP,files:Object.fromEntries(Object.entries(files).map(([n,r])=>[n,{dev:r.dev,ino:r.ino}]))});
 const finish=status=>{
  if(terminal)return;terminal=true;let failed=status!=='complete';
  for(const r of Object.values(files)){try{fs.fsyncSync(r.fd);}catch{failed=true;}try{fs.closeSync(r.fd);}catch{failed=true;}}
  try{writeRecord(dir,'closed.json',{status:failed?'failed':'complete',total,bytes:Object.fromEntries(Object.entries(files).map(([n,r])=>[n,r.bytes]))});}catch{failed=true;}
  if(failed)onFailure();
 };
 for(const name of ['stdout','stderr']){
  child[name].on('data',b=>{if(terminal)return;try{need(Buffer.isBuffer(b)&&total+b.length<=LOG_CAP,'stream cap reached');const r=files[name];let n=0;while(n<b.length){const wrote=fs.writeSync(r.fd,b,n,b.length-n);need(wrote>0,'short write');n+=wrote;r.bytes+=wrote;total+=wrote;}}catch{finish('failed');}});
  child[name].once('error',()=>finish('failed'));
 }
 child.once('error',()=>finish('failed'));child.once('close',()=>finish('complete'));
 return {get terminal(){return terminal;}};
}
export function inspectCanaryLogs({dir,hostPid,hostStartTicks,requireComplete=false}){
 directory(dir);const names=fs.readdirSync(dir).sort();need(names.join(',')===(names.includes('closed.json')?'closed.json,opened.json,stderr.log,stdout.log':'opened.json,stderr.log,stdout.log'),'unexpected log entry');
 const readRecord=name=>{const p=path.join(dir,name),s=stat(p);need(s.size<=16384,'oversized metadata');return JSON.parse(fs.readFileSync(p,'utf8'));};
 const opened=readRecord('opened.json');need(opened.version===1&&opened.hostPid===hostPid&&opened.hostStartTicks===hostStartTicks&&opened.cap===LOG_CAP,'host generation or stream cap differs');
 const files={};let total=0;
 for(const name of ['stdout','stderr']){const p=path.join(dir,name+'.log'),before=stat(p);need(before.size<=LOG_CAP&&before.dev===opened.files?.[name]?.dev&&before.ino===opened.files?.[name]?.ino,'stream replaced or oversized');const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
  try{const s=fs.fstatSync(fd);need(s.dev===before.dev&&s.ino===before.ino&&s.size===before.size,'stream changed before read');bytes=Buffer.alloc(before.size);let n=0;while(n<bytes.length){const got=fs.readSync(fd,bytes,n,bytes.length-n,n);need(got>0,'incomplete prefix');n+=got;}const after=fs.fstatSync(fd);need(after.size===before.size&&after.mtimeNs===before.mtimeNs&&after.mtimeMs===before.mtimeMs,'stream changed during read');}finally{fs.closeSync(fd);}
  total+=before.size;files[name]={bytes:before.size,sha256:sha(bytes),dev:before.dev,ino:before.ino};bytes.fill(0);
 }
 need(total<=LOG_CAP,'aggregate stream cap exceeded');let status='open';if(names.includes('closed.json')){const c=readRecord('closed.json');need(c.status==='complete'&&c.total===total&&Object.entries(files).every(([n,r])=>c.bytes?.[n]===r.bytes),'capture failed or final byte count differs');status='complete';}
 need(!requireComplete||status==='complete','capture has not completed');
 return {status,hostPid,hostStartTicks,cap:LOG_CAP,total,files,scope:'Private local guest-stream provenance only; not attestation or proof that plaintext stayed out of a relay.'};
}
