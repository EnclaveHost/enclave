// Verify the frozen dependency closure before importing any non-builtin code.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const stage = path.dirname(fileURLToPath(import.meta.url));
export const sha256 = b => createHash('sha256').update(b).digest('hex');
export const VENDOR_PIN = '18bc7bfbd061d6fb2c378f6636b784e45b9f2c81d04de859d2c190347bfec77a';
export async function readBounded(file,max) {
  const f=await fs.open(file,'r');try{
    const st=await f.stat();if(!st.isFile()||st.size>max)throw Error('file type/size bound');
    const parts=[];let n=0;
    while(true){const b=Buffer.alloc(Math.min(65536,max+1-n));const r=await f.read(b,0,b.length,null);
      if(!r.bytesRead)break;n+=r.bytesRead;if(n>max)throw Error('file grew beyond bound');parts.push(b.subarray(0,r.bytesRead));}
    return Buffer.concat(parts);
  }finally{await f.close();}
}
export async function verifyVendor(root=stage,expected=VENDOR_PIN) {
  const raw=await readBounded(path.join(root,'VENDOR.json'),4<<20);
  if(sha256(raw)!==expected)throw Error('vendor manifest pin mismatch');
  const m=JSON.parse(raw);if(m.format!=='enclave-capture-vendor/v1')throw Error('vendor manifest format');
  const names=Object.keys(m.files).sort();if(names.length>20000)throw Error('vendor file count');
  const seen=[];let total=0;
  async function walk(relative){
    for(const name of await fs.readdir(path.join(root,relative))){
      const rel=`${relative}/${name}`,full=path.join(root,rel),st=await fs.lstat(full);
      if(st.isSymbolicLink())throw Error('vendor symlink refused');
      if(st.isDirectory())await walk(rel);
      else if(st.isFile()){
        if(!Object.hasOwn(m.files,rel))throw Error('unmanifested vendor file');
        total+=st.size;if(total>(64<<20)||seen.length>=20000)throw Error('vendor size bound');
        const bytes=await readBounded(full,8<<20);
        if(sha256(bytes)!==m.files[rel])throw Error(`vendor source pin mismatch: ${rel}`);
        seen.push(rel);
      }else throw Error('nonregular vendor entry');
    }
  }
  const rootStat=await fs.lstat(path.join(root,'vendor'));
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw Error('vendor root must be a real directory');
  await walk('vendor');
  if(JSON.stringify(seen.sort())!==JSON.stringify(names))throw Error('vendor file set mismatch');
  return {manifestSha256:expected,files:m.files,nodeVersion:process.version};
}
if(Number(process.versions.node.split('.')[0])<22)throw Error('Node 22 or later required');
export const vendorProvenance=await verifyVendor();
export async function sourceProvenance(){
  const files={};for(const name of ['capture.mjs','evaluate.mjs','runtime.mjs','policy.mjs'])files[name]=sha256(await readBounded(path.join(stage,name),256<<10));
  return {stageSourceSha256:files,vendorManifestSha256:VENDOR_PIN,dependencySha256:Object.fromEntries(['vendor/op-head-relay.mjs','vendor/rpc-identity.mjs','vendor/source-package-lock.json'].map(n=>[n,vendorProvenance.files[n]])),nodeVersion:process.version};
}
export async function requireOffline(){
  // /proc/self/net follows the calling process network namespace; a shared
  // sysfs mount can still expose interfaces from its original namespace.
  const devices=(await readBounded('/proc/self/net/dev',64<<10)).toString();
  const interfaces=devices.split('\n').filter(line=>line.includes(':')).map(line=>line.slice(0,line.indexOf(':')).trim());
  if(interfaces.some(n=>n!=='lo'))throw Error('isolated offline network namespace required');
}
