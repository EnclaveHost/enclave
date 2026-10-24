// Local log provenance only. Never exports guest text or calls a signer, starts a VM, or records a lifecycle pass.
import fs from 'node:fs';
import path from 'node:path';
import {canonical,sha256hex} from './canonical.mjs';
import {guardPrivateDir} from './markers.mjs';
import {inspectCanaryLogs,LOG_CAP} from './private-log.mjs';
const need=(ok,m)=>{if(!ok)throw Error('custodian window refused: '+m);};
const hash=x=>sha256hex(canonical(x));
const H=/^[a-f0-9]{64}$/,ID=/^0x[a-f0-9]{64}$/;
export const MAX_WINDOW_MS=300000;
function binding(x){
 need(x&&ID.test(x.id)&&!/^0x0{64}$/.test(x.id)&&ID.test(x.encKey)&&!/^0x0{64}$/.test(x.encKey)&&H.test(x.stepHash)&&/^[a-f0-9]{96}$/.test(x.measurement),'deployment, key, step and measurement pins required');
 const u=new URL(x.recipientEndpoint);need(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.href===x.recipientEndpoint,'exact recipient HTTPS endpoint required');
 return {id:x.id,encKey:x.encKey,stepHash:x.stepHash,measurement:x.measurement,recipientEndpoint:x.recipientEndpoint};
}
function runtime(r){
 need(r?.status==='runtime-verified'&&r.protectedServicesUnchanged===true&&r.loopbackPortsVerified===true&&H.test(r.bundleDigest),'verified live runtime required');
 const l=r.privateLogs;need(l?.status==='open'&&l.hostPid===r.hostPid&&/^\d+$/.test(l.hostStartTicks),'open logs tied to live host generation required');
 need(Number.isSafeInteger(r.hostPid)&&r.hostPid>1&&Number.isSafeInteger(r.guestPid)&&r.guestPid>1&&/^[a-f0-9]{32}$/.test(r.invocation)&&/^enclave-custody-r2-\d{8}T\d{6}Z\.service$/.test(r.unit),'runtime generation missing');
 return {unit:r.unit,invocation:r.invocation,bundleDigest:r.bundleDigest,hostPid:r.hostPid,guestPid:r.guestPid,hostStartTicks:l.hostStartTicks};
}
// Read a fixed snapshot, refusing append/replacement races. Buffers never leave this module.
function bytesOf(dir,name,want){
 guardPrivateDir(dir);need(['stdout','stderr'].includes(name)&&Number.isSafeInteger(want?.bytes)&&want.bytes>=0&&want.bytes<=LOG_CAP&&H.test(want.sha256),'invalid log snapshot');
 const p=path.join(dir,name+'.log'),fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let b;
 try{
  const before=fs.fstatSync(fd,{bigint:true});
  need(before.isFile()&&before.uid===BigInt(process.getuid())&&(before.mode&0o777n)===0o600n&&before.nlink===1n&&String(before.dev)===String(want.dev)&&String(before.ino)===String(want.ino)&&before.size===BigInt(want.bytes),'private stream identity or size differs');
  b=Buffer.alloc(want.bytes);let n=0;while(n<b.length){const got=fs.readSync(fd,b,n,b.length-n,n);need(got>0,'incomplete log snapshot');n+=got;}
  const after=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(p,{bigint:true});
  need(['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(k=>before[k]===after[k]&&after[k]===named[k])&&!named.isSymbolicLink(),'stream changed during collection');
  need(sha256hex(b)===want.sha256,'stream digest differs');return b;
 }catch(e){b?.fill(0);throw e;}finally{fs.closeSync(fd);}
}
function snapshot(dir,r){const v=runtime(r),s=inspectCanaryLogs({dir,hostPid:v.hostPid,hostStartTicks:v.hostStartTicks});need(hash(s)===hash(r.privateLogs),'logs changed after runtime inspection');return s;}
function fresh(at,now,max=30000){need(Number.isSafeInteger(at)&&Number.isSafeInteger(now)&&now>=at&&now-at<=max,'observation expired or clock moved backward');}
export async function beginCustodianWindow({dir,identity,inspectRuntime,now=()=>Date.now()}){
 const pins=binding(identity),began=now(),r=await inspectRuntime();fresh(r.at,now());const generation=runtime(r),logs=snapshot(dir,r);
 const final=await inspectRuntime();need(hash(runtime(final))===hash(generation)&&hash(final.privateLogs)===hash(logs),'runtime or logs changed while opening window');fresh(began,now());fresh(final.at,now());
 const cursor={version:1,beganAt:now(),identity:pins,generation,logs};return {cursor,digest:hash(cursor),status:'window-open',scope:'Only subsequent complete log lines from this process generation may be collected.'};
}
function countsOf(lines,pins){
 const counts={matchingReleases:0,matchingRefusals:0,measurementRefusals:0,wrongIdentity:0,syntheticReleases:0,malformedOrError:0,refusalCodes:{}};
 for(const line of lines){
  if(!line.includes('release '+pins.id+' '))continue;
  const m=/^\[custodian-v2 ([0-9a-f]{12})\] release (0x[0-9a-f]{64}) to (\S+): (.*)$/.exec(line);
  if(!m){counts.malformedOrError++;continue;}
  if(m[1]!==pins.encKey.slice(2,14)||m[3]!==pins.recipientEndpoint){counts.wrongIdentity++;continue;}
  const ok=/^OK \(indices ([0-9,]+), measurement ([0-9a-f]{16})\.\.\.(, SYNTHETIC roots)?\)$/.exec(m[4]);
  if(ok){if(ok[3])counts.syntheticReleases++;else if(ok[2]!==pins.measurement.slice(0,16))counts.wrongIdentity++;else counts.matchingReleases++;continue;}
  const no=/^REFUSED ([a-z_]{1,64}): /.exec(m[4]);
  if(no){counts.matchingRefusals++;if(no[1]==='evidence_refused'&&m[4].slice(no[0].length).includes('measurement'))counts.measurementRefusals++;const code=['evidence_refused','runtime_not_admitted','paused','wrong_committee','stale','unauthorized','internal'].includes(no[1])?no[1]:'other';counts.refusalCodes[code]=(counts.refusalCodes[code]??0)+1;}else counts.malformedOrError++;
 }
 return counts;
}
export async function collectCustodianWindow({dir,cursor,digest,identity,inspectRuntime,now=()=>Date.now()}){
 need(H.test(digest)&&hash(cursor)===digest&&cursor.version===1,'cursor changed');need(hash(binding(identity))===hash(cursor.identity),'window identity differs');fresh(cursor.beganAt,now(),MAX_WINDOW_MS);
 const r=await inspectRuntime();fresh(r.at,now());need(hash(runtime(r))===hash(cursor.generation),'runtime changed since window began');const current=snapshot(dir,r),lines=[],ranges={};
 for(const name of ['stdout','stderr']){
  const old=cursor.logs.files[name],end=current.files[name];need(old.dev===end.dev&&old.ino===end.ino&&end.bytes>=old.bytes,'stream replaced or truncated');
  const b=bytesOf(dir,name,end);
  try{
   need(sha256hex(b.subarray(0,old.bytes))===old.sha256,'prior log prefix changed');
   let start=old.bytes;
   // A line which started before the window never becomes a new release when its suffix arrives.
   if(start>0&&b[start-1]!==10){const lf=b.indexOf(10,start);start=lf<0?b.length:lf+1;}
   const last=b.lastIndexOf(10),stop=last>=start?last+1:start;
   lines.push(...b.subarray(start,stop).toString('utf8').split('\n').filter(Boolean));
   ranges[name]={from:old.bytes,to:end.bytes,completeFrom:start,completeTo:stop,sha256:sha256hex(b.subarray(old.bytes))};
  }finally{b.fill(0);}
 }
 const final=await inspectRuntime();need(hash(runtime(final))===hash(cursor.generation)&&hash(final.privateLogs)===hash(current),'runtime or logs changed during collection');fresh(final.at,now());fresh(cursor.beganAt,now(),MAX_WINDOW_MS);
 return {status:'custodian-window-collected',windowDigest:digest,generation:cursor.generation,identity:cursor.identity,from:cursor.beganAt,to:now(),ranges,counts:countsOf(lines,cursor.identity),
  scope:'Local, bounded custodian log interval only; not authenticated guest logs, recipient identity, release consumption, outage or recovery success. Fresh SNP, recipient-generation and HMAC evidence remain mandatory.'};
}

function cursorPath(dir,name){guardPrivateDir(dir);need(/^custodian-window-[A-Za-z0-9.]+-\d{8}T\d{6}Z\.json$/.test(name),'invalid cursor name');return path.join(dir,name);}
export function saveCustodianWindow({dir,name,window}){
 need(window?.status==='window-open'&&hash(window.cursor)===window.digest,'invalid open window');
 const file=cursorPath(dir,name),fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,JSON.stringify(window)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const parent=fs.openSync(dir,fs.constants.O_RDONLY);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
 return {status:'window-open',digest:window.digest,beganAt:window.cursor.beganAt,scope:window.scope};
}
export function loadCustodianWindow({dir,name,digest}){
 const file=cursorPath(dir,name);let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd,{bigint:true});
  need(s.isFile()&&s.nlink===1n&&s.uid===BigInt(process.getuid())&&(s.mode&0o777n)===0o600n&&s.size>0n&&s.size<=16384n,'private bounded cursor required');
  const b=Buffer.alloc(Number(s.size));let n=0;while(n<b.length){const got=fs.readSync(fd,b,n,b.length-n,n);need(got>0,'incomplete cursor');n+=got;}
  const end=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(file,{bigint:true});
  need(['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(k=>s[k]===end[k]&&end[k]===named[k])&&!named.isSymbolicLink(),'cursor changed during read');
  const w=JSON.parse(b.toString('utf8'));need(w.status==='window-open'&&w.digest===digest&&H.test(digest)&&hash(w.cursor)===digest,'cursor digest differs');return w;
 }catch{throw Error('custodian window refused: private cursor unavailable, malformed or changed');}finally{if(fd!==undefined)fs.closeSync(fd);}
}
