// Explicit opt-in native RPC controller. No legacy launcher, replay, adoption,
// readiness or release. Default main does not enable it without operator pins.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {canonical,sha256Hex} from './derive.mjs';
import {exactRPCKeys,validateRPCRecord} from './rpc-derive.mjs';
import {captureRPCAttempt,freezeRPC} from './rpc-admission.mjs';
const HASH=/^[0-9a-f]{64}$/;
const NAMES=new Set(['begin.intent.json','begin.result.json','stage.intent.json','stage.result.json','define.intent.json','define.result.json','hold.intent.json','hold.result.json']);
const keys=['schema','ledgerRoot','attemptsRoot','workersRoot','runtimeId','profileSha256','admissionSha256','firmwareSha256','initialStateSha256','workerSha256','admissionPath','firmwarePath','initialStatePath','profilePath','workerPath'];
function hash(x){if(typeof x!=='string'||x.length!==64||!HASH.test(x)||x==='0'.repeat(64))throw Error('RPC native digest');return x;}
function readFile(file,maximum){
 const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>maximum)throw Error('RPC native regular bounded single-link input required');
 const fd=fs.openSync(file,'r');try{const actual=fs.fstatSync(fd);if(actual.dev!==before.dev||actual.ino!==before.ino||actual.size!==before.size||actual.nlink!==1)throw Error('RPC native file changed');const b=Buffer.alloc(actual.size);let n=0;while(n<b.length){const r=fs.readSync(fd,b,n,b.length-n,n);if(!r)throw Error('RPC native short read');n+=r;}return b;}finally{fs.closeSync(fd);}
}
function identity(x){exactRPCKeys(x,['managerEpoch','id','name','instanceId'],'native identity');if(!/^[0-9a-f]{32}$/.test(x.managerEpoch)||x.managerEpoch.length!==32||!/^rpc[0-9a-f]{32}$/.test(x.id)||x.id.length!==35||x.id!==x.instanceId||x.name.length!==66||!x.name.startsWith('0x'))throw Error('RPC native manager identity');hash(x.name.slice(2));return structuredClone(x);}
function original(a,configSha,id=null){
 exactRPCKeys(a,['schema','config','attempt','boot','managerEpoch','instance','deployment','originMs','deadlineMs','physicalMemoryMiB','appMemoryMiB','cpuUnits','reservationMayRelease'],'native original');
 if(a.schema!=='native-rpc-manager-attempt/1'||a.config!==configSha||a.physicalMemoryMiB!==20480||a.appMemoryMiB!==19456||a.cpuUnits!==400000||a.reservationMayRelease!==false)throw Error('RPC native original reservation');
 for(const k of ['attempt','boot','managerEpoch'])if(typeof a[k]!=='string'||a[k].length!==32||!/^[0-9a-f]{32}$/.test(a[k])||a[k]==='0'.repeat(32))throw Error('RPC native original identity');
 const bound=identity({managerEpoch:a.managerEpoch,id:a.instance,instanceId:a.instance,name:a.deployment});if(id&&Object.keys(bound).some(k=>bound[k]!==id[k]))throw Error('RPC native original differs from manager');
 captureRPCAttempt({originalClock:{originMs:a.originMs,deadlineMs:a.deadlineMs},assertCurrent:()=>true,start:()=>{},stop:()=>{}});return freezeRPC(structuredClone(a));
}
// Node transport limits are collection controls, not proof of native tree death.
// The pinned native command independently arms its own watchdog/job before input.
export function invokeNativeProcess(executable,args,input,{timeoutMs=35000,outputLimit=131072}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>35000||outputLimit!==131072)throw Error('RPC native transport limits');
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});let bytes=0,errorBytes=0,parts=[],failure=null,settled=false,force;
  const done=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(force);err?reject(err):resolve(value);};
  const fail=reason=>{if(failure)return;failure=Error(reason+'; original RPC attempt held');child.stdin.destroy();try{child.kill();}catch{}force=setTimeout(()=>done(failure),1000);};
  const timer=setTimeout(()=>fail('RPC native collection deadline'),timeoutMs);
  child.on('error',e=>{failure=Error('RPC native process unavailable: '+e.code);done(failure);});
  child.stdout.on('data',b=>{bytes+=b.length;if(bytes>outputLimit)fail('RPC native response bound');else parts.push(b);});
  child.stderr.on('data',b=>{errorBytes+=b.length;if(errorBytes>65536)fail('RPC native diagnostic bound');});
  child.stdin.on('error',()=>fail('RPC native input response lost'));
  child.on('close',(code,signal)=>{
   if(failure)return done(failure);if(code!==0||signal)return done(Error('RPC native command failed; original attempt held'));
   try{const raw=Buffer.concat(parts),reply=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));done(null,reply);}catch{done(Error('RPC native malformed response; original attempt held'));}
  });
  // Write with backpressure, never a shell or arguments containing payloads.
  (async()=>{try{for(const b of input??[]){if(failure)return;if(!child.stdin.write(b))await new Promise((r,j)=>{const drain=()=>{cleanup();r();},error=e=>{cleanup();j(e);},cleanup=()=>{child.stdin.off('drain',drain);child.stdin.off('error',error);child.stdin.off('close',closed);},closed=()=>error(Error('input closed'));child.stdin.once('drain',drain);child.stdin.once('error',error);child.stdin.once('close',closed);});}child.stdin.end();}catch{fail('RPC native pipe write failed');}})();
 });
}
export async function createNativeRPCController({executable,executableSha256,configPath,configSha256},dependencies={}){
 // Dependencies are a test seam for fixture processes. Production main passes
 // none; the actual native executable must run on Windows and verify its ACLs.
 if(process.platform!=='win32'&&!dependencies.invoke)throw Error('RPC native controller requires Windows');
 hash(executableSha256);hash(configSha256);for(const p of [executable,configPath])if(!path.isAbsolute(p))throw Error('RPC native absolute operator path');
 const verifyPins=()=>{if(sha256Hex(readFile(executable,262144))!==executableSha256||sha256Hex(readFile(configPath,65536))!==configSha256)throw Error('RPC native operator pin changed');};verifyPins();
 const config=JSON.parse(readFile(configPath,65536));exactRPCKeys(config,keys,'native configuration');if(config.schema!=='native-rpc-manager-controller/1')throw Error('RPC native configuration schema');
 for(const k of keys.filter(k=>k.endsWith('Sha256')||k==='runtimeId'))hash(config[k]);
 const root=path.join(config.ledgerRoot,'transport');if(!path.isAbsolute(root)||fs.lstatSync(root).isSymbolicLink()||!fs.lstatSync(root).isDirectory()||fs.realpathSync(root)!==path.resolve(root))throw Error('RPC native transport namespace');
 const invoke=dependencies.invoke??invokeNativeProcess,now=dependencies.now??(()=>performance.now());
 const files=new Map();
 for(const name of fs.readdirSync(root)){if(!NAMES.has(name)||files.size>=8)throw Error('RPC native unknown transport history');const raw=readFile(path.join(root,name),131072);JSON.parse(raw);files.set(name,sha256Hex(raw));}
 const currentFiles=()=>{verifyPins();const names=fs.readdirSync(root);if(names.length!==files.size)throw Error('RPC native transport history changed');for(const n of names)if(files.get(n)!==sha256Hex(readFile(path.join(root,n),131072)))throw Error('RPC native transport record changed');return true;};
 const put=(name,value)=>{currentFiles();if(!NAMES.has(name)||files.has(name))throw Error('RPC native command already consumed');const raw=Buffer.from(JSON.stringify(value));if(raw.length>131072)throw Error('RPC native transport record bound');let fd;
  try{fd=fs.openSync(path.join(root,name),'wx',0o600);fs.writeFileSync(fd,raw);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;files.set(name,sha256Hex(raw));}
  catch(e){if(fd!==undefined)fs.closeSync(fd);throw e;} // partial final is consumed, never removed
 };
 const call=async(command,args=[],input=[],timeoutMs=35000)=>{
  currentFiles();const reply=await invoke(executable,[command,configPath,configSha256,...args],input,{timeoutMs,outputLimit:131072});currentFiles();
  exactRPCKeys(reply,['schema','command','value','elapsedMs','rpcReady','providerOperationFenced','reservationMayRelease'],'native response');
  if(reply.schema!=='native-rpc-manager-controller-result/2'||reply.command!==command||reply.rpcReady!==false||reply.providerOperationFenced!==false||reply.reservationMayRelease!==false||!Number.isSafeInteger(reply.elapsedMs)||reply.elapsedMs<0||reply.elapsedMs>=30000)throw Error('RPC native response binding');return reply.value;
 };
 // Native inspect validates the protected configured namespace. Neither an
 // absent JS Map nor a missing reply is evidence that the native ledger is empty.
 const inventory=await call('inspect');if(!['empty','held'].includes(inventory.state)||inventory.reservationMayRelease!==false)throw Error('RPC native inventory unknown');
 let state=inventory.state==='empty'&&files.size===0?'empty':'held',active=null;
 const recovered=[];
 if(state==='held'){
  let id,clock=null;
  if(inventory.state==='held'){active=original(inventory.original,configSha256);hash(inventory.originalSha256);id={managerEpoch:active.managerEpoch,id:active.instance,instanceId:active.instance,name:active.deployment};clock={originMs:active.originMs,deadlineMs:active.deadlineMs};}
  else {const intent=JSON.parse(readFile(path.join(root,'begin.intent.json'),131072));id=identity(intent.identity);if(intent.config!==configSha256)throw Error('RPC native consumed begin configuration');}
  recovered.push(freezeRPC({id:id.id,name:id.name,instanceId:id.instanceId,originalManagerEpoch:id.managerEpoch,
   imageRole:'rpc',rpcHeld:true,recovered:true,status:'starting',launching:false,originalClock:clock,
   physicalMemoryMiB:20480,memory:{appMiB:19456},cpu:{vcpus:4,grantedUnits:400000},gpuMilli:0,
   appReady:false,hostExcluded:false,providerOperationFenced:false,reservationMayRelease:false,
   reason:'Original native RPC attempt remains held across restart; no adoption or resubmission'}));
 }
 return Object.freeze({runtimeId:config.runtimeId,profileSha256:config.profileSha256,
  assertInventory:()=>currentFiles(),recoverHeld:()=>structuredClone(recovered),
  begin:async value=>{
   const id=identity(value);if(state!=='empty')throw Error('RPC native original attempt already held');state='beginning';const sentAt=now();
   try{
    put('begin.intent.json',{schema:'rpc-native-send/1',config:configSha256,identity:id,command:'begin'});
    const begun=await call('begin',[id.managerEpoch,id.id,id.name]);exactRPCKeys(begun,['original','originalSha256'],'native begin receipt');
    active=original(begun.original,configSha256,id);const digest=hash(begun.originalSha256);put('begin.result.json',{original:active,sha256:digest});state='owned';
    const localEnd=sentAt+900000;let started=false,stopped=false;
    const current=()=>{currentFiles();return !stopped&&now()>=sentAt&&now()<localEnd;};
    const budget=()=>{if(!current()||localEnd-now()<35000)throw Error('RPC original time insufficient for a bounded native phase');return Math.min(35000,Math.floor(localEnd-now()));};
    return {originalClock:Object.freeze({originMs:active.originMs,deadlineMs:active.deadlineMs}),assertCurrent:current,
     start:async(launch,bundle)=>{
      if(started||stopped)throw Error('RPC native launch already consumed');started=true;state='starting';budget();
      if(!Buffer.isBuffer(bundle)||bundle.length<1||bundle.length>9*1048576)throw Error('RPC native bundle bound');
      validateRPCRecord(launch.record);
      if(launch.managerEpoch!==id.managerEpoch||launch.id!==id.id||launch.instanceId!==id.instanceId||launch.name!==id.name||launch.physicalMemoryMiB!==20480||launch.originalClock.originMs!==active.originMs||launch.originalClock.deadlineMs!==active.deadlineMs||sha256Hex(bundle)!==launch.appId||sha256Hex(canonical(launch.record))!==launch.recordSha256)throw Error('RPC native launch identity differs');
      const header=Buffer.from(JSON.stringify({launch:JSON.stringify(launch),record:canonical(launch.record).toString('utf8'),bundleBytes:bundle.length}));if(header.length>196608)throw Error('RPC native header bound');const length=Buffer.alloc(4);length.writeUInt32LE(header.length);
      put('stage.intent.json',{original:digest,launchSha256:sha256Hex(Buffer.from(JSON.stringify(launch))),bundleSha256:launch.appId,recordSha256:launch.recordSha256});
      const stage=await call('stage',[digest],[length,header,bundle],budget());
      exactRPCKeys(stage,['original','launchSha256','recordSha256','bundleSha256','bundleBytes','reservationMayRelease'],'native stage');
      if(stage.original!==digest||stage.recordSha256!==launch.recordSha256||stage.bundleSha256!==launch.appId||stage.bundleBytes!==bundle.length||stage.reservationMayRelease!==false)throw Error('RPC native staging differs');hash(stage.launchSha256);put('stage.result.json',stage);
      budget();put('define.intent.json',{original:digest,stageSha256:sha256Hex(Buffer.from(JSON.stringify(stage)))});
      const result=await call('define-staged',[digest],[],budget());
      if(result.state!=='defined-native-owned-off'||result.startAuthorized!==false||result.providerOperationFenced!==false||result.reservationMayRelease!==false)throw Error('RPC native definition not settled Off');
      put('define.result.json',result);state='held';return Object.freeze({rpcReady:false,providerOperationFenced:false,reservationMayRelease:false});
     },
     stop:async()=>{if(stopped)throw Error('RPC native stop already held');stopped=true;state='held';put('hold.intent.json',{original:digest});const result=await call('hold',[digest]);if(result.held!==true||result.reservationMayRelease!==false||result.providerOperationFenced!==false)throw Error('RPC native hold result');put('hold.result.json',result);throw Error('RPC original local gate held; provider/writer settlement and release are unproven');}
    };
   }catch(e){state='held';throw e;}
  }
 });
}
