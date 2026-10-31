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
const out={schema:'template-config-diagnostic/1',readOnly:true,config:null,master:null,errors:[],allOldIssuerInputsProven:false,priorOperationsSettled:false,capacityAdmitted:false};
const known=new Set(['file-kind-size','file-identity','file-changed','nonliteral-template-assignment','template-pin-format','template-path-scope','duplicate-template-assignment','ENOENT','EACCES','EPERM','EBUSY']);
function why(e){return known.has(e.code)?e.code:known.has(e.message)?e.message:'unavailable';}
let phase='open-read-identity';
try{
 const c=configs[1],f=boundedFile(c.path,65536),hash=sha(f.bytes);
 out.config={path:c.path,identity:f.identity,expectedSha:c.hash,observedSha:hash,pinMatches:hash===c.hash};phase='hash';
 if(hash!==c.hash)out.errors.push({stage:'config',phase,reason:'config-pin-differs'});
 else {phase='decode';let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(f.bytes);}catch{throw Error('utf8-invalid');}
 phase='assignments';Object.assign(out.config,assignmentProjection(text));}
}catch(e){out.errors.push({stage:'config',phase,reason:e.message==='utf8-invalid'?'utf8-invalid':why(e)});}
// Exact master/path pin independently obtained from the previous successful
// Shield projection. This does not infer every live issuer uses this object.
const master=String.raw`C:\ProgramData\Enclave\shield\type1.vmgs`;
try{const f=boundedFile(master,16*1024*1024),hash=sha(f.bytes);out.master={path:master,identity:f.identity,sha256:hash,expectedSha:'e93237a717a7e0e9fa201db2b331d2ed480274bfa47145854ea3ba85852abb96',pinMatches:hash==='e93237a717a7e0e9fa201db2b331d2ed480274bfa47145854ea3ba85852abb96'};}
catch(e){out.errors.push({stage:'master',reason:why(e)});}
process.stdout.write(JSON.stringify(out)+'\n');
