// Host-side operational recovery guard. Ciphertext is delivered only to the local guest's state API.
// This cannot authenticate an untrusted host or provide a monotonic rollback anchor.
import fs from 'node:fs';import path from 'node:path';import {sha256hex} from './canonical.mjs';
const need=(v,m)=>{if(!v)throw Error('recovery state refused: '+m);};
export function createRecoveryStateGate({file,expected}) {
 need(typeof file==='string'&&path.isAbsolute(file)&&path.normalize(file)===file,'canonical absolute state path required');
 need(/^[a-f0-9]{64}$/.test(expected?.sha256??'')&&Number.isSafeInteger(expected?.bytes)&&expected.bytes>=28&&expected.bytes<=4194304,'bounded sealed-state fingerprint required');
 for(const k of ['dev','ino','mtimeNs','ctimeNs'])need(/^\d+$/.test(expected[k]??''),'complete file-generation metadata required');
 let hasRead=false;
 return {
  get hasRead(){return hasRead;},
  read(){
   // A missing file is an ERROR, never a 404 permitting fresh identity creation.
   const parent=path.dirname(file),d=fs.lstatSync(parent);need(fs.realpathSync(parent)===parent&&d.isDirectory()&&!d.isSymbolicLink()&&d.uid===process.getuid()&&(d.mode&511)===448,'private canonical state directory required');
   const check=s=>{need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.uid===BigInt(process.getuid())&&(s.mode&511n)===384n&&s.size===BigInt(expected.bytes),'private retained file required');
    for(const k of ['dev','ino','mtimeNs','ctimeNs'])need(String(s[k])===expected[k],'retained file generation changed');};
   check(fs.lstatSync(file,{bigint:true}));need(fs.realpathSync(file)===file,'state path changed');
   const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
   try{check(fs.fstatSync(fd,{bigint:true}));bytes=fs.readFileSync(fd);check(fs.fstatSync(fd,{bigint:true}));check(fs.lstatSync(file,{bigint:true}));
    need(bytes.length===expected.bytes&&sha256hex(bytes)===expected.sha256,'sealed bytes differ');hasRead=true;return bytes;
   }catch(e){bytes?.fill(0);throw Error('recovery state refused: retained ciphertext unavailable or changed');}finally{fs.closeSync(fd);}
  },
  requireRead(){need(hasRead,'state write before verified recovery read');},
 };
}
