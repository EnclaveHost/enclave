import fs from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const inputs=[['hyperv.psm1','17ca4352c500d3498f71be420ddfa418c7ed1d1b5f455856c24e633a4635e49c'],['utilities.psm1','517766e996ddb021594c0ae2c7a60688d4293e2ee9459f558f2a436e6da30731']];
const out={schema:'installed-hyperv-dependencies/1',readOnly:true,importsPerformed:false,files:[]};
const id=s=>[s.dev,s.ino,s.size,s.nlink,s.mtimeNs,s.ctimeNs].map(String).join(':');
for(const [name,pin] of inputs){
 const path=String.raw`C:\Program Files\Enclave\guest`+'\\'+name;
 const named=fs.lstatSync(path,{bigint:true});if(!named.isFile()||named.isSymbolicLink()||named.size<1n||named.size>65536n||named.nlink!==1n)throw Error('file-bound');
 const fd=fs.openSync(path,'r');try{
  const first=fs.fstatSync(fd,{bigint:true});if(id(first)!==id(named))throw Error('identity');
  const b=Buffer.alloc(Number(first.size)+1);let n=0;while(n<b.length){const got=fs.readSync(fd,b,n,b.length-n,n);if(!got)break;n+=got;}
  const end=fs.fstatSync(fd,{bigint:true});if(n!==Number(first.size)||id(first)!==id(end)||id(end)!==id(fs.statSync(path,{bigint:true})))throw Error('changed');
  const bytes=b.subarray(0,n),observed=sha(bytes);if(observed!==pin)throw Error('installed-pin-mismatch');
  out.files.push({name,path,sha256:observed,bytes:n,identity:id(end),base64:bytes.toString('base64')});
 }finally{fs.closeSync(fd);}
}
const text=JSON.stringify(out);if(Buffer.byteLength(text)>200000)throw Error('output-bound');process.stdout.write(text+'\n');
