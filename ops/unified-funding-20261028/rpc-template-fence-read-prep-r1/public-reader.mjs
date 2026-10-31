// PREPARED ONLY. Target-side public projection; never import application modules.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const pick=(o,ks)=>Object.fromEntries(ks.filter(k=>Object.hasOwn(o??{},k)).map(k=>[k,o[k]]));
const KEYS=['ENCLAVE_GUEST_STATE_MASTER','ENCLAVE_GUEST_STATE_MASTER_SHA256','ENCLAVE_GUEST_STATE_RUN_DIR','ENCLAVE_GUEST_STATE_ARCHIVE_DIR'];
const SHIELD=String.raw`C:\ProgramData\Enclave\shield-config.cmd`;
const RUNNER=String.raw`C:\ProgramData\Enclave\native-manager\releases\58ca73a0d002619990c25eedc4d66188533dd76b739afdc2cd8e0efbb4d1a929\run-manager.cmd`;
const configs=[{path:SHIELD,hash:'d688c172b44b21267067ed390803aff1c957f01e13549e6d82f1bd4e01496047',basis:'retained sidecar bootstrap external pin'},
 {path:RUNNER,hash:'97d27cf986e13069e9bb257b9b7f3dd133025ad3e0957bbdb6094844d80b3c1c',basis:'retained repair-runner.ps1 and runner-repaired.json'}];
const identity=s=>({device:s.dev.toString(),fileIndex:s.ino.toString(),links:s.nlink.toString(),bytes:s.size.toString(),mtimeNs:s.mtimeNs.toString(),ctimeNs:s.ctimeNs.toString()});
function boundedFile(p,max){
 const lst=fs.lstatSync(p,{bigint:true});if(!lst.isFile()||lst.isSymbolicLink()||lst.size>BigInt(max))throw Error('file-kind-size');
 const fd=fs.openSync(p,'r');try{
  const first=fs.fstatSync(fd,{bigint:true});if(!first.isFile()||first.size<1n||first.size>BigInt(max)||first.ino!==lst.ino||first.dev!==lst.dev)throw Error('file-identity');
  const b=Buffer.alloc(Number(first.size)+1);let n=0;while(n<b.length){const got=fs.readSync(fd,b,n,b.length-n,n);if(!got)break;n+=got;}
  const last=fs.fstatSync(fd,{bigint:true}),named=fs.statSync(p,{bigint:true});
  if(n!==Number(first.size)||JSON.stringify(identity(first))!==JSON.stringify(identity(last))||JSON.stringify(identity(last))!==JSON.stringify(identity(named)))throw Error('file-changed');
  return {bytes:b.subarray(0,n),identity:identity(last)};
 }finally{fs.closeSync(fd);}
}
function assignmentProjection(text){
 const fields={},counts={};let knownShieldCalls=0,otherCalls=0;
 for(const raw of text.split(/\r?\n/)){
  const line=raw.trim();
  const m=/^@?set\s+(?:"([A-Z0-9_]+)=([^"\r\n]*)"|([A-Z0-9_]+)=([^\r\n]*))\s*$/i.exec(line);
  if(m){const key=(m[1]??m[3]).toUpperCase(),value=m[2]??m[4];if(KEYS.includes(key)){
   counts[key]=(counts[key]??0)+1;
   if(/[%!&|<>^]/.test(value))throw Error('nonliteral-template-assignment');
   if(key.endsWith('_SHA256')){if(!/^[0-9a-f]{64}$/.test(value))throw Error('template-pin-format');fields[key]=value;}
   else {const p=path.win32.normalize(value);if(!/^C:\\ProgramData\\Enclave\\/i.test(p)||value.includes('..'))throw Error('template-path-scope');fields[key]=p;}
  }}
  if(/^@?call\s/i.test(line)){
   if(/^@?call\s+"C:\\ProgramData\\Enclave\\shield-config\.cmd"\s*$/i.test(line))knownShieldCalls++;else otherCalls++;
  }
 }
 if(Object.values(counts).some(n=>n!==1))throw Error('duplicate-template-assignment');
 return {fields,knownShieldCalls,otherCalls};
}
const result={schema:'legacy-template-readiness-public/1',readOnly:true,configs:[],masters:[],observations:[],errors:[],
 allOldIssuerInputsProven:false,loadedEnvironmentProven:false,heldNamespaceProof:false,priorOperationsSettled:false,capacityAdmitted:false};
for(const c of configs){try{
 const f=boundedFile(c.path,65536),hash=sha(f.bytes);if(hash!==c.hash)throw Error('config-pin-differs');
 result.configs.push({path:c.path,sha256:hash,identity:f.identity,basis:c.basis,...assignmentProjection(new TextDecoder('utf-8',{fatal:true}).decode(f.bytes))});
}catch{result.errors.push({stage:'config',path:c.path,reason:'pinned-public-projection-unavailable'});}}
if(result.configs.length===2){
 const [base,runner]=result.configs;
 if(runner.knownShieldCalls!==1||runner.otherCalls!==0)result.errors.push({stage:'config-chain',reason:'runner-inheritance-not-exact'});
 else {
  const native={...base.fields,...runner.fields},sources=[{role:'retained-shield-config',fields:base.fields},{role:'native-runner-effective-literal-fields',fields:native}];
  const unique=new Map();for(const x of sources){const p=x.fields.ENCLAVE_GUEST_STATE_MASTER;if(!p||!p.toLowerCase().endsWith('.vmgs')){result.errors.push({stage:'master',reason:'master-path-missing'});continue;}
   if(!unique.has(p.toLowerCase()))unique.set(p.toLowerCase(),{path:p,roles:[],configuredHashes:[]});const u=unique.get(p.toLowerCase());u.roles.push(x.role);if(x.fields.ENCLAVE_GUEST_STATE_MASTER_SHA256)u.configuredHashes.push(x.fields.ENCLAVE_GUEST_STATE_MASTER_SHA256);
  }
  for(const x of unique.values())try{const f=boundedFile(x.path,16*1024*1024),hash=sha(f.bytes);result.masters.push({...x,identity:f.identity,sha256:hash,configuredPinsMatch:x.configuredHashes.every(p=>p===hash),configuredHashPresent:x.configuredHashes.length>0});}
   catch{result.errors.push({stage:'master',path:x.path,reason:'master-public-facts-unavailable'});}
 }
}
function get(port,url){return new Promise((resolve,reject)=>{
 let req,done=false;const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);if(e){req?.destroy();reject(e);}else resolve(v);};
 const timer=setTimeout(()=>finish(Error('deadline')),2500);
 req=http.request({hostname:'127.0.0.1',port,path:url,method:'GET',agent:false},res=>{let size=0;const chunks=[];
  res.on('data',b=>{size+=b.length;if(size>262144)finish(Error('body-limit'));else if(!done)chunks.push(b);});
  res.on('aborted',()=>finish(Error('aborted')));res.on('error',()=>finish(Error('body-error')));
  res.on('end',()=>{if(done)return;try{finish(null,{status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{finish(Error('json'));}});
 });req.on('error',()=>finish(Error('transport')));req.end();
});}
function rows(xs,fn){if(!Array.isArray(xs)||xs.length>128)throw Error('rows');return xs.map(fn);}
function health(h){return {...pick(h,['managerEpoch','backend','canStart','instanceNamespace']),vmScope:pick(h.vmScope,['prefix','marker']),
 inventory:pick(h.inventory,['state']),sharedPhysicalPool:pick(h.sharedPhysicalPool,['poolHash','boot']),
 memory:pick(h.memory,['rule','poolMiB','known','reservedMiB','freeMiB']),physicalMemory:pick(h.physicalMemory,['poolMiB','allocatedMiB','freeMiB']),
 cpu:pick(h.cpu,['poolVcpus','unitsPerVcpu','allocatedUnits','freeUnits','hostLogicalProcessors']),
 allocation:pick(h.allocation,['schema','scope','managerEpoch','revision','known','preparing','heldMiB','atomicHostReservation'])};}
function list(x){return {managerEpoch:x.managerEpoch,vms:rows(x.vms,r=>({...pick(r,['id','name','status','recovered','unattributed','imageRole','physicalMemoryMiB','gpuMilli']),
 memory:pick(r.memory,['appMiB','vmMiB']),cpu:pick(r.cpu,['grantedUnits','appCpuPercent'])}))};}
const tasks=[];for(const port of [8091,8095,8097])for(const url of ['/health','/vms'])tasks.push({port,url,project:url==='/health'?health:list});
tasks.push({port:9600,url:'/v1/host/state',project:x=>({deployments:rows(x.deployments,r=>pick(r,['id','status','cpuShare','memMb','isolationRequired']))})});
await Promise.all(tasks.map(async t=>{try{const r=await get(t.port,t.url);if(r.status!==200)throw Error('http');result.observations.push({port:t.port,path:t.url,status:r.status,data:t.project(r.body)});}catch{result.errors.push({stage:'public-http',port:t.port,path:t.url,reason:'unavailable'});}}));
result.observations.sort((a,b)=>a.port-b.port||a.path.localeCompare(b.path));
const out=JSON.stringify(result);if(Buffer.byteLength(out)>180000)throw Error('output-bound');process.stdout.write(out+'\n');
