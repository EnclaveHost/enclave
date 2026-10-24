// Keep the original QEMU serial descriptor across guestd's failure cleanup. Its archived tail is insufficient.
import fs from 'node:fs';import path from 'node:path';
import {canonical,sha256hex} from './canonical.mjs';
import {recipientInternals as R,linuxRecipientIO} from './recipient-observer.mjs';
const need=(ok,m)=>{if(!ok)throw Error('recipient failure observation refused: '+m);};
const hash=x=>sha256hex(canonical(x)),MAX=4*1024*1024;
const H=/^[a-f0-9]{64}$/,VM=/^gd[a-f0-9]{8}$/;
function guest(v,pins,cursor,now){
 need(v&&VM.test(v.id)&&!cursor.oldIds.includes(v.id)&&v.name===pins.id&&['starting','failed'].includes(v.status),'fresh non-serving recipient required');
 need(v.appId===pins.appId&&v.runtimeId===pins.runtimeId&&v.measurement===pins.measurement&&v.hostData===pins.id.slice(2)&&H.test(v.recordSha256)&&v.backend==='snp-guest-per-app','recipient image or deployment differs');
 need(Number.isSafeInteger(v.createdAt)&&v.createdAt>=Math.ceil(cursor.beganAt/1000)&&v.createdAt<=Math.floor(now/1000),'recipient predates baseline');
 return Object.fromEntries(['id','name','createdAt','appId','runtimeId','measurement','hostData','recordSha256'].map(k=>[k,v[k]]));
}
export function holdRecipientSerial({file,process:proc,io}){
 const dir=path.dirname(file),d=fs.lstatSync(dir);
 need(path.isAbsolute(file)&&fs.realpathSync(dir)===dir&&d.isDirectory()&&d.uid===process.getuid()&&(d.mode&0o777)===0o700,'private canonical directory required');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let closed=false;
 const close=()=>{if(!closed){closed=true;fs.closeSync(fd);}};
 try {
  const start=fs.fstatSync(fd,{bigint:true}),writer=io.openFile(proc.pid,file);
  need(start.isFile()&&start.nlink===1n&&start.uid===BigInt(process.getuid())&&(start.mode&0o022n)===0n&&start.size<=BigInt(MAX),'bounded owned serial required');
  need(writer.dev===String(start.dev)&&writer.ino===String(start.ino)&&writer.writable===true&&hash(io.process(proc.pid))===hash(proc),'live QEMU writer required');
  return {close,read(){
   need(!closed&&!io.generationAlive(proc),'original QEMU must have exited');
   const s=fs.fstatSync(fd,{bigint:true});
   need(s.isFile()&&s.dev===start.dev&&s.ino===start.ino&&s.uid===start.uid&&s.mode===start.mode&&s.nlink<=1n&&s.size>0n&&s.size>=start.size&&s.size<=BigInt(MAX),'retained serial changed or exceeds bound');
   const b=Buffer.alloc(Number(s.size));try{
    let n=0;while(n<b.length){const got=fs.readSync(fd,b,n,b.length-n,n);need(got>0,'short serial read');n+=got;}
    const end=fs.fstatSync(fd,{bigint:true});need(['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(k=>s[k]===end[k])&&!io.generationAlive(proc),'serial or process changed during terminal read');
    return {text:b.toString('utf8'),bytes:b.length,sha256:sha256hex(b),dev:String(s.dev),ino:String(s.ino),retainedDescriptor:true};
   }finally{b.fill(0);}
  }};
 }catch(e){close();throw e;}
}
export async function observeFailedRecipient({identity:pin,cursor,digest,client,io=linuxRecipientIO(),now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),openSerial=holdRecipientSerial,timeoutMs=60000}){
 const pins=R.identity(pin);need(H.test(digest)&&hash(cursor)===digest&&cursor.version===1&&hash(cursor.identity)===hash(pins),'cursor differs');
 need(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000,'bounded observation required');
 const started=now();let last=started,observed=null,proc=null,held=null;
 try{
  for(let ticks=0;ticks<=Math.ceil(timeoutMs/200);ticks++){
   const at=now();need(at>=last&&at-started<=timeoutMs,'clock moved or observation expired');last=at;R.fresh(cursor.beganAt,at,300000);
   const before=io.snapshot();R.fresh(before.at,now());R.unchanged(cursor.before,before,cursor.oldPids);
   const list=await R.vmList(client);need(client.instance===cursor.instance,'authenticated manager changed');
   const fresh=list.filter(v=>v.name===pins.id&&!cursor.oldIds.includes(v.id));need(fresh.length<=1,'more than one new recipient');
   if(!fresh.length){need(!observed,'observed recipient disappeared before failure confirmation');await sleep(200);continue;}
   need(!list.some(v=>v.name===pins.id&&v.status==='running'),'a recipient served during refusal');
   const v=fresh[0];
   // Build may still be pending. Never claim observation until measurement and the actual writer exist.
   if(!observed&&!v.measurement&&v.status==='starting'){await sleep(200);continue;}
   const g=guest(v,pins,cursor,now());if(observed)need(hash(g)===hash(observed),'recipient metadata changed');
   const q=before.qemus.filter(p=>R.isGuest(io.args(p.pid),g.id));
   if(!held){
    need(v.status==='starting','failed boot was not observed live');
    if(!q.length){await sleep(200);continue;}
    need(q.length===1&&!cursor.before.qemus.some(p=>p.pid===q[0].pid)&&q[0].uid===process.getuid()&&path.basename(q[0].exe)==='qemu-system-x86_64','fresh owned QEMU required');
    const args=io.args(q[0].pid);R.hostData(args,pins.id);proc=q[0];held=openSerial({file:R.serialArg(args,g.id),process:proc,io});observed=g;
   }
   if(v.status==='failed'&&!io.generationAlive(proc)){
    need(q.length===0,'recipient has another live QEMU');const serial=held.read();
    const again=await client.get('/vms/'+g.id);need(again.status===200&&again.body?.status==='failed'&&hash(guest(again.body,pins,cursor,now()))===hash(g)&&client.instance===cursor.instance,'failed metadata changed');
    const after=io.snapshot();R.fresh(after.at,now());R.unchanged(before,after);R.unchanged(cursor.before,after,cursor.oldPids);
    need(!io.generationAlive(proc)&&hash(before.qemus)===hash(after.qemus),'terminal VM census changed');
    R.fresh(cursor.beganAt,now(),300000);need(now()>=started&&now()-started<=timeoutMs,'terminal observation expired');
    const {text,...log}=serial;
    need(text.endsWith('\n'),'terminal serial line incomplete');
    return {status:'recipient-failure-observed',identity:pins,instance:g,process:proc,attemptDigest:digest,custodianWindowDigest:cursor.custodianWindowDigest,startedAt:started,at:now(),log,front:R.frontCounts(text,pins.id),
     scope:'Fresh authenticated failed instance and retained complete serial from an observed live QEMU; operational provenance, not SNP attestation or an outage/recovery pass.'};
   }
   need(q.length===1&&hash(q[0])===hash(proc)&&io.generationAlive(proc),'recipient exited without confirmed failed state');
   await sleep(200);
  }
  throw Error('recipient failure observation expired');
 }finally{held?.close();}
}
