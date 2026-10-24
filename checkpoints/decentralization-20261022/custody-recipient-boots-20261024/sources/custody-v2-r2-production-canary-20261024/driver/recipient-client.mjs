// Only GET operations are exposed. The pairing credential stays local and is cleared on close.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {sha256hex} from './canonical.mjs';
export const CONTROL_CLIENT_SHA256='8cddbb9b5c1483330ac13cca0e206fd1c92af58a86e0dbb1db37675790498dc6';
export async function loadRecipientClient(pins){
 const rel='isolation/m4/guestd/control-client.mjs',file=path.join(pins.repo.path,rel);
 if(pins.repo.files?.[rel]!==CONTROL_CLIENT_SHA256||sha256hex(fs.readFileSync(file))!==CONTROL_CLIENT_SHA256)throw Error('recipient client source is not pinned');
 const cfg=pins.recipient?.guestd;
 if(cfg?.endpoint!=='http://127.0.0.1:8095'||cfg?.keyFile!=='/home/steven/enclave-prod/guestd-pair.key')throw Error('original local guestd configuration required');
 const fd=fs.openSync(cfg.keyFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let raw,key;
 try{
  const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||(s.mode&0o777)!==0o600||s.size<64||s.size>65)throw Error('private pairing file required');
  raw=Buffer.alloc(s.size);let n=0;while(n<raw.length){const got=fs.readSync(fd,raw,n,raw.length-n,n);if(got<=0)throw Error('pairing read incomplete');n+=got;}
  const end=fs.fstatSync(fd),named=fs.lstatSync(cfg.keyFile);if(['dev','ino','size','mtimeMs','ctimeMs','mode','nlink'].some(k=>s[k]!==end[k]||end[k]!==named[k])||named.isSymbolicLink())throw Error('pairing file changed');
  const {GuestdControl,parseKey}=await import(pathToFileURL(file).href);key=parseKey(raw.toString('utf8'));
  const client=new GuestdControl(cfg.endpoint,key,{requestTimeoutMs:10000,maxResponseBytes:131072});let closed=false;
  return {get instance(){return client.instance;},async get(route){
   if(closed||!/^\/vms(?:\/gd[a-f0-9]{8})?$/.test(route))throw Error('recipient reader only permits bounded VM metadata GETs');
   try{return await client.request('GET',route);}catch{throw Error('authenticated recipient metadata unavailable');}
  },close(){closed=true;key.fill(0);client.session?.key?.fill(0);}};
 }catch{key?.fill(0);throw Error('recipient pairing or reviewed client unavailable');}finally{raw?.fill(0);fs.closeSync(fd);}
}
