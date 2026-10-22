import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
const sourcePath=path.resolve('work/app-lease-gas-root-journal-review/supervisor-reviewed.js');
const source=fs.readFileSync(sourcePath,'utf8');
const strict=source.slice(source.indexOf('function saveStateStrict('),source.indexOf('function initStatePersistence('));
const ordinary=source.slice(source.indexOf('function saveStateNow('),source.indexOf('function saveStateSoon('));
if (!strict.includes('fsyncSync') || !ordinary.includes('renameSync')) throw Error('source changed: review harness');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-journal-review-'));
try {
 const state=path.join(dir,'state.json'), payload=JSON.stringify({releaseIntents:[{id:'review-only',txs:[{sponsored:true,intents:[{nonce:'42'}]}]}]});
 const calls=[];let short=false;
 const context=vm.createContext({STATE_FILE:state,_statePersistable:true,_stateCorrupt:null,_stateDirty:true,serializeState:()=>payload,dirname:path.dirname,console,
  openSync:(...a)=>{calls.push(['open',a[0]]);return fs.openSync(...a)},closeSync:fs.closeSync,
  writeSync:(fd,text)=>{calls.push(['writeSync']);if(short){const b=Buffer.from(text);return fs.writeSync(fd,b,0,Math.floor(b.length/2));}return fs.writeSync(fd,text)},
  writeFileSync:(...a)=>{calls.push(['writeFileSync']);return fs.writeFileSync(...a)},
  renameSync:(...a)=>{calls.push(['rename']);return fs.renameSync(...a)},
  fsyncSync:(...a)=>{calls.push(['fsync']);return fs.fsyncSync(...a)}});
 vm.runInContext(strict+'\n'+ordinary,context);
 vm.runInContext('saveStateStrict("review")',context);
 const strictCalls=calls.splice(0).map(x=>x[0]);
 vm.runInContext('saveStateNow()',context);
 const ordinaryCalls=calls.splice(0).map(x=>x[0]);
 short=true;vm.runInContext('saveStateStrict("short write review")',context);
 const bytes=fs.readFileSync(state,'utf8');let valid=true;try{JSON.parse(bytes)}catch{valid=false}
 const result={sourcePath,sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),strictCalls,subsequentOrdinarySaveCalls:ordinaryCalls,
   ordinarySaveReplacesDurableJournalWithoutFsync:ordinaryCalls.includes('rename')&&!ordinaryCalls.includes('fsync'),
   shortWrite:{strictReturnedSuccess:true,expectedBytes:Buffer.byteLength(payload),actualBytes:Buffer.byteLength(bytes),validJson:valid},
   scope:'Actual candidate writer function bodies, filesystem fault injection; no production write or physical power-loss simulation.'};
 fs.writeFileSync('work/app-lease-gas-root-journal-review/result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
