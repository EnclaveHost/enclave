// Read-only recipient boot provenance. No process/lease mutations and no hardware or outage pass.
import fs from 'node:fs';import path from 'node:path';
import {canonical,sha256hex} from './canonical.mjs';
import {guardPrivateDir} from './markers.mjs';
import {linuxRuntimeIO} from './launch-runtime.mjs';
const need=(x,m)=>{if(!x)throw Error('recipient observation refused: '+m);},hash=x=>sha256hex(canonical(x));
const H=/^[0-9a-f]{64}$/,ID=/^0x[0-9a-f]{64}$/,VM=/^gd[0-9a-f]{8}$/;
const MAX_MS=300000,MAX_SERIAL=4*1024*1024;
function identity(x){need(ID.test(x?.id)&&!/^0x0{64}$/.test(x.id)&&H.test(x.appId)&&H.test(x.runtimeId)&&H.test(x.stepHash)&&/^[a-f0-9]{96}$/.test(x.measurement),'pinned canary identity required');return {id:x.id,appId:x.appId,runtimeId:x.runtimeId,stepHash:x.stepHash,measurement:x.measurement};}
function fresh(at,now,max=30000){need(Number.isSafeInteger(at)&&Number.isSafeInteger(now)&&now>=at&&now-at<=max,'observation expired or clock moved backward');}
function service(s){need(s?.units?.['enclave-guestd.service']&&typeof s.bootId==='string'&&s.bootId.length>0,'guestd process identity missing');return {bootId:s.bootId,units:s.units};}
function unchanged(before,after,allowedAbsent=[]){need(hash(service(before))===hash(service(after)),'host or protected service generation changed');const permitted=new Set(allowedAbsent);for(const p of before.qemus)if(!permitted.has(p.pid))need(after.qemus.some(q=>hash(q)===hash(p)),'unrelated VM changed');}
function serialArg(args,id){const values=[];for(let i=0;i<args.length;i++)if(args[i]==='-serial')values.push(args[i+1]);need(values.length===1&&typeof values[0]==='string'&&values[0].startsWith('file:'),'one file serial device required');const file=values[0].slice(5);need(path.isAbsolute(file)&&path.basename(file)===id+'.serial'&&path.basename(path.dirname(file))===id,'serial path differs from guest instance');return file;}
function isGuest(args,id){try{serialArg(args,id);return true;}catch{return false;}}
function hostData(args,id){const objects=[];for(let i=0;i<args.length;i++)if(args[i]==='-object'&&args[i+1]?.startsWith('sev-snp-guest,'))objects.push(args[i+1]);need(objects.length===1,'one SNP guest object required');const vals=objects[0].split(',').filter(v=>v.startsWith('host-data='));need(vals.length===1&&vals[0].slice(10)===Buffer.from(id.slice(2),'hex').toString('base64'),'QEMU host data differs from canary deployment');}
async function vmList(client){const r=await client.get('/vms');need(r?.status===200&&Array.isArray(r.body?.vms)&&r.body.vms.length<=256&&/^[a-f0-9]{32}$/.test(client.instance),'authenticated VM census missing');return r.body.vms;}
function oldGuests(list,id){return list.filter(v=>v.name===id).map(v=>{need(VM.test(v.id),'invalid old recipient instance');return v.id;}).sort();}
export async function beginRecipientAttempt({identity:pin,custodianWindowDigest,client,io=linuxRuntimeIO(),now=()=>Date.now()}){
 need(H.test(custodianWindowDigest),'custodian window digest required');
 const pins=identity(pin),before=io.snapshot();fresh(before.at,now());const list=await vmList(client),instance=client.instance,ids=oldGuests(list,pins.id);
 const oldPids=before.qemus.filter(p=>ids.some(id=>isGuest(io.args(p.pid),id))).map(p=>p.pid);
 const after=io.snapshot();fresh(after.at,now());unchanged(before,after);need(hash(before.qemus)===hash(after.qemus),'VM census changed during baseline');
 need(client.instance===instance,'guestd authenticated instance changed');
 const cursor={version:1,beganAt:now(),identity:pins,custodianWindowDigest,instance,oldIds:ids,oldPids,before:after};
 return {status:'recipient-attempt-open',cursor,digest:hash(cursor),scope:'Read-only baseline before root restarts this dedicated canary. No restart is performed.'};
}
function checkedGuest(v,pins,cursor,now){
 need(v?.status==='running'&&VM.test(v.id)&&!cursor.oldIds.includes(v.id)&&v.name===pins.id&&v.appId===pins.appId&&v.runtimeId===pins.runtimeId&&v.measurement===pins.measurement,'fresh running recipient identity differs');
 need(v.backend==='snp-guest-per-app'&&v.hostData===pins.id.slice(2)&&H.test(v.recordSha256)&&H.test(v.transportKeySha256),'guest record, transport key or host data missing');
 need(Number.isSafeInteger(v.createdAt)&&v.createdAt>=Math.ceil(cursor.beganAt/1000)&&v.createdAt<=Math.floor(now/1000),'recipient was not created after the attempt baseline');
 return Object.fromEntries(['id','name','status','createdAt','appId','runtimeId','measurement','hostData','recordSha256','transportKeySha256'].map(k=>[k,v[k]]));
}
export function readRecipientSerial({file,process,io}){
 const dir=path.dirname(file),d=fs.lstatSync(dir);need(path.isAbsolute(file)&&fs.realpathSync(dir)===dir&&d.isDirectory()&&d.uid===globalThis.process.getuid()&&(d.mode&0o777)===0o700,'private canonical recipient directory required');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let b;
 try{
  const s=fs.fstatSync(fd,{bigint:true});need(s.isFile()&&s.nlink===1n&&s.uid===BigInt(globalThis.process.getuid())&&(s.mode&0o022n)===0n&&s.size>0n&&s.size<=BigInt(MAX_SERIAL),'bounded owned serial file required');
  const owned=io.openFile(process.pid,file);need(owned.dev===String(s.dev)&&owned.ino===String(s.ino)&&owned.writable===true,'serial is not open for writing by this QEMU');
  b=Buffer.alloc(Number(s.size));let n=0;while(n<b.length){const got=fs.readSync(fd,b,n,b.length-n,n);need(got>0,'incomplete serial');n+=got;}
  const end=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(file,{bigint:true});need(['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(k=>s[k]===end[k]&&end[k]===named[k])&&!named.isSymbolicLink(),'serial changed during read');
  need(hash(io.process(process.pid))===hash(process),'recipient process changed while reading serial');
  return {bytes:b.length,sha256:sha256hex(b),dev:String(s.dev),ino:String(s.ino),text:b.toString('utf8')};
 }catch(e){throw e;}finally{b?.fill(0);fs.closeSync(fd);}
}
function frontCounts(text,id){
 const counts={releases:[],custodyErrors:0,quorumErrors:0,serving:0,otherDeployment:0};
 // Only complete lines; no raw line, error detail or certificate fingerprint is returned.
 const last=text.lastIndexOf('\n');for(const line of text.slice(0,last<0?0:last+1).replaceAll('\r','').split('\n')){
  const m=/^DOM custody: deployment 0x([a-f0-9]{8})\.\.\. secrets revision (\d+) from a v2 threshold of (\d+) over (\d+) custodian machines, (\d+) name\(s\)$/.exec(line);
  if(m){if(m[1]!==id.slice(2,10))counts.otherDeployment++;else counts.releases.push({secretRev:Number(m[2]),threshold:Number(m[3]),seats:Number(m[4]),names:Number(m[5])});}
  if(/^DOM ERROR front: .*custody/.test(line))counts.custodyErrors++;
  if(line.includes('insufficient custodian quorum'))counts.quorumErrors++;
  if(line.startsWith('DOM serving '))counts.serving++;
 }
 return counts;
}
export async function collectRecipientAttempt({identity:pin,cursor,digest,client,io=linuxRecipientIO(),now=()=>Date.now(),readSerial=readRecipientSerial}){
 const pins=identity(pin);need(H.test(digest)&&hash(cursor)===digest&&cursor.version===1&&hash(cursor.identity)===hash(pins),'recipient cursor or identity changed');fresh(cursor.beganAt,now(),MAX_MS);
 const before=io.snapshot();fresh(before.at,now());unchanged(cursor.before,before,cursor.oldPids);
 const list=await vmList(client);need(client.instance===cursor.instance,'guestd authenticated instance changed');
 const candidates=list.filter(v=>v.name===pins.id&&v.status==='running');need(candidates.length===1,'exactly one running canary recipient required');const g=checkedGuest(candidates[0],pins,cursor,now());
 const qemus=before.qemus.filter(p=>isGuest(io.args(p.pid),g.id));need(qemus.length===1,'one live QEMU for this recipient required');const q=qemus[0];
 need(!cursor.before.qemus.some(p=>p.pid===q.pid)&&q.uid===globalThis.process.getuid()&&path.basename(q.exe)==='qemu-system-x86_64','recipient process is not a fresh owned QEMU');
 const args=io.args(q.pid);hostData(args,pins.id);const file=serialArg(args,g.id),serial=readSerial({file,process:q,io});
 const again=await client.get('/vms/'+g.id);need(again.status===200&&hash(checkedGuest(again.body,pins,cursor,now()))===hash(g)&&client.instance===cursor.instance,'recipient metadata or guestd changed');
 const after=io.snapshot();fresh(after.at,now());unchanged(before,after);need(hash(before.qemus)===hash(after.qemus)&&hash(io.process(q.pid))===hash(q),'VM census changed during collection');fresh(cursor.beganAt,now(),MAX_MS);
 const {text,...log}=serial;
 return {status:'recipient-observed',attemptDigest:digest,custodianWindowDigest:cursor.custodianWindowDigest,identity:pins,instance:g,process:q,log,front:frontCounts(text,pins.id),at:now(),
  scope:'Authenticated guestd metadata plus live local QEMU and complete bounded serial snapshot. Host observations are not SNP attestation, app consumption, outage proof or malicious-host protection.'};
}
export function linuxRecipientIO(){
 return {...linuxRuntimeIO(),openFile:(pid,file)=>{
  const hits=[];for(const name of fs.readdirSync('/proc/'+pid+'/fd')){
   const p='/proc/'+pid+'/fd/'+name;let target;try{target=fs.readlinkSync(p);}catch(e){if(e.code==='ENOENT')continue;throw e;}if(target!==file)continue;
   const st=fs.statSync(p,{bigint:true}),flags=fs.readFileSync('/proc/'+pid+'/fdinfo/'+name,'utf8').match(/^flags:\s+([0-7]+)$/m);need(flags,'serial descriptor flags missing');
   hits.push({dev:String(st.dev),ino:String(st.ino),writable:(parseInt(flags[1],8)&3)!==0});
  }need(hits.length===1,'exactly one QEMU serial descriptor required');return hits[0];
 }};
}


function attemptFile(dir,name){guardPrivateDir(dir);need(/^recipient-[A-Za-z0-9.]+-\d{8}T\d{6}Z\.json$/.test(name),'invalid recipient cursor name');return path.join(dir,name);}
export function saveRecipientAttempt({dir,name,attempt}){
 need(attempt?.status==='recipient-attempt-open'&&hash(attempt.cursor)===attempt.digest,'invalid recipient baseline');
 const file=attemptFile(dir,name),fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,JSON.stringify(attempt)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const parent=fs.openSync(dir,fs.constants.O_RDONLY);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
 return {status:attempt.status,digest:attempt.digest,beganAt:attempt.cursor.beganAt,scope:attempt.scope};
}
export function loadRecipientAttempt({dir,name,digest}){
 let fd;try{
  const file=attemptFile(dir,name);fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd,{bigint:true});
  need(s.isFile()&&s.uid===BigInt(process.getuid())&&s.nlink===1n&&(s.mode&0o777n)===0o600n&&s.size>0n&&s.size<=65536n,'bounded private recipient cursor required');
  const b=Buffer.alloc(Number(s.size));let n=0;while(n<b.length){const got=fs.readSync(fd,b,n,b.length-n,n);need(got>0,'short cursor');n+=got;}
  const end=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(file,{bigint:true});need(['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(k=>s[k]===end[k]&&end[k]===named[k])&&!named.isSymbolicLink(),'recipient cursor changed');
  const v=JSON.parse(b.toString('utf8'));need(v.status==='recipient-attempt-open'&&H.test(digest)&&v.digest===digest&&hash(v.cursor)===digest,'recipient cursor digest changed');return v;
 }catch{throw Error('recipient observation refused: private cursor unavailable, malformed or changed');}finally{if(fd!==undefined)fs.closeSync(fd);}
}
