// Canary-only host capture: no RPC, wallet, key access or broadcasting. Guest authorization signatures stay private.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {canonical} from './canonical.mjs';
import {R2,METAL0_REGISTRY_ID} from './plan.mjs';
const H=/^0x[0-9a-f]{64}$/, A=/^0x[0-9a-f]{40}$/;
const fail=()=>{throw Error('invalid canary genesis capture');};
const sha=x=>createHash('sha256').update(x).digest('hex');
export function validateCaptureDirectory(dir, io=fs) {
 if(typeof dir!=='string'||!path.isAbsolute(dir)||io.realpathSync(dir)!==dir)fail();
 const st=io.lstatSync(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o777)!==0o700||st.uid!==process.getuid())fail();
 return dir;
}
export function validateCaptureEndpoint(endpoint) {
 let u;try{u=new URL(endpoint);}catch{fail();}
 if(u.protocol!=='https:'||u.origin!==endpoint||u.username||u.password)fail();
 return endpoint;
}
function normalize(body,endpoint) {
 validateCaptureEndpoint(endpoint);
 if(!Buffer.isBuffer(body)||body.length>16384)fail();
 const p=JSON.parse(body.toString('utf8'));
 if(!p||Array.isArray(p)||Object.keys(p).sort().join(',')!=='args,fn'||p.fn!=='createCommittee'||!Array.isArray(p.args)||p.args.length!==6)fail();
 const [salt,m,Y,codes,identitySig,hostSig]=p.args;
 if(!H.test(salt)||!m||Array.isArray(m)||Object.keys(m).sort().join(',')!=='chipId,encKey,endpoint,identity,measurement,registryId'
  ||!A.test(m.identity)||/^0x0{40}$/.test(m.identity)||!['chipId','encKey','registryId','measurement'].every(k=>H.test(m[k])&&!/^0x0{64}$/.test(m[k]))
  ||m.endpoint!==endpoint||m.registryId!==METAL0_REGISTRY_ID||m.measurement!==R2.measurementSha256
  ||!/^0x0[23][0-9a-f]{64}$/.test(Y)||!Array.isArray(codes)||codes.length!==1||codes[0]!==R2.measurementSha256
  ||![identitySig,hostSig].every(s=>/^0x[0-9a-f]{130}$/.test(s)))fail();
 return {fn:p.fn,args:p.args};
}
const syncDir=(dir,io)=>{const fd=io.openSync(dir,'r');try{io.fsyncSync(fd);}finally{io.closeSync(fd);}};
function read(dir,endpoint,io) {
 const file=path.join(dir,'genesis-request.json');
 const fd=io.openSync(file,io.constants.O_RDONLY|io.constants.O_NOFOLLOW);
 try {
  const st=io.fstatSync(fd);if(!st.isFile()||(st.mode&0o777)!==0o600||st.uid!==process.getuid()||st.size>20000)fail();
  const rec=JSON.parse(io.readFileSync(fd,'utf8'));
  if(rec.v!==1||typeof rec.digest!=='string'||Object.keys(rec).sort().join(',')!=='digest,request,v')fail();
  const req=normalize(Buffer.from(canonical(rec.request)),endpoint);
  if(sha(canonical(req))!==rec.digest)fail();
  return rec;
 }finally{io.closeSync(fd);}
}
// Caller must keep returned request private; only the digest is public metadata.
export function readCapturedGenesis({dir,endpoint,io=fs}) {
 validateCaptureDirectory(dir,io);return read(dir,endpoint,io);
}
export function captureGenesis({dir,endpoint,body,io=fs}) {
 try {
  validateCaptureDirectory(dir,io);const request=normalize(body,endpoint),digest=sha(canonical(request));
  const final=path.join(dir,'genesis-request.json');
  if(io.existsSync(final)){
   const old=read(dir,endpoint,io);
   if(old.digest!==digest)return {status:409,code:'canary_genesis_conflict'};
   syncDir(dir,io);return {status:503,code:'canary_genesis_captured',digest};
  }
  const tmp=path.join(dir,`.genesis-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
   fd=io.openSync(tmp,io.constants.O_WRONLY|io.constants.O_CREAT|io.constants.O_EXCL,0o600);
   io.writeFileSync(fd,JSON.stringify({v:1,digest,request})+'\n');io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
   // Atomic, exclusive publication. No partial or conflicting capture replaces a prior request.
   io.linkSync(tmp,final);io.unlinkSync(tmp);syncDir(dir,io);
  }finally{if(fd!==undefined)io.closeSync(fd);if(io.existsSync(tmp))io.unlinkSync(tmp);}
  return {status:503,code:'canary_genesis_captured',digest};
 }catch{return {status:503,code:'canary_capture_refused'};}
}
