// Invoked only by the pinned HostBootstrapChannels child. No TCP listener,
// command selection, key generation, default launcher or environment config.
import fs from 'node:fs';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {createRPCBootstrapHost} from './bootstrap.mjs';
import {nativeWire,mapNativeClock} from './native-wire.mjs';

async function main(){
 if(process.platform!=='win32'||process.arch!=='x64'||process.argv.length!==2)throw Error('native Windows entry required');
 const lost=new AbortController(),wire=nativeWire(process.stdin,process.stdout,lost.signal);
 let fd,timer;
 try{
  const before=process.hrtime.bigint();await wire.sendControl('clock');
  const receipt=JSON.parse(await wire.receiveControl());
  const clock=mapNativeClock(receipt,before,()=>process.hrtime.bigint());
  if(typeof receipt.token!=='string'||!/^[0-9a-f]{128}$/.test(receipt.token)||!/^[0-9a-f]{32}$/.test(receipt.boot)||
    typeof receipt.journal!=='string'||!receipt.journal.endsWith('\\host-journal.jsonl')||typeof receipt.privateKeyPem!=='string'||receipt.privateKeyPem.length>16384)throw Error('native binding receipt differs');
  timer=setTimeout(()=>lost.abort(),Math.max(1,Number((clock.phaseDeadlineNs-clock.now())/1000000n)));
  const privateKey=createPrivateKey(receipt.privateKeyPem);receipt.privateKeyPem=null;
  const spki=createPublicKey(privateKey).export({type:'spki',format:'der'});
  // The native parent holds the protected attempt directory and its ancestors.
  // wx consumes this phase. Node's mode is not a claim about Windows DACLs.
  fd=fs.openSync(receipt.journal,'wx',0o600);
  const host=createRPCBootstrapHost({monitor:wire.monitor,tpm:wire.tpm,nodeKey:{privateKey,spki},journalFd:fd,
   expected:receipt.expected,ekChain:receipt.ekChain,original:clock.original,now:clock.now,signal:lost.signal});
  const enrollment=await host.enroll();await wire.sendControl('enroll\n'+JSON.stringify(enrollment));
  const offer=JSON.parse(await wire.receiveControl());
  await host.finish(offer);
  await wire.sendControl('acquisition-requested');
 }finally{clearTimeout(timer);if(fd!==undefined)fs.closeSync(fd);wire.close();}
}
main().catch(()=>{process.exitCode=1;process.stderr.write('RPC host bootstrap refused; consumed attempt retained\n');});
