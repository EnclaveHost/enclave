// Fixed three-lane transport over the native parent's anonymous stdio pipes.
// This module provides framing, not native containment or peer authentication.
import {Duplex} from 'node:stream';
const LIMIT=131072, CHUNK=32768;
export function nativeWire(input,output,signal){
 let pending=Buffer.alloc(0),closed=false,error=null,control=null,waiter=null,total=0;
 let tail=Promise.resolve();
 function alive(){if(closed||signal.aborted)throw error??Error('native supervisor pipe lost');}
 function close(e=Error('native supervisor pipe closed')){
  if(closed)return;closed=true;error=e;signal.removeEventListener('abort',aborted);
  input.removeListener('data',data);input.removeListener('end',ended);input.removeListener('close',ended);
  for(const s of streams)s.destroy(e);waiter?.reject(e);waiter=null;input.destroy();output.destroy();
 }
 const aborted=()=>close(Error('native supervisor lost')),ended=()=>close(Error('native supervisor EOF'));
 function send(lane,bytes){
  alive();bytes=Buffer.from(bytes);if(lane<0||lane>2||!bytes.length||bytes.length>(lane===0?LIMIT:13*1048576))throw Error('native frame write bound');
  // Only one finite pending write per Duplex; all shared stdout writes serialized.
  const operation=tail.then(async()=>{for(let at=0;at<bytes.length;at+=lane===0?LIMIT:CHUNK){
   alive();const body=bytes.subarray(at,at+(lane===0?LIMIT:CHUNK)),header=Buffer.alloc(5);header[0]=lane;header.writeUInt32BE(body.length,1);
   await new Promise((resolve,reject)=>output.write(Buffer.concat([header,body]),e=>e?reject(e):resolve()));
  }});
  tail=operation.catch(e=>close(e));return operation;
 }
 const streams=[1,2].map(lane=>{
  const s=new Duplex({read(){},write(chunk,_,cb){send(lane,chunk).then(()=>cb(),cb);},destroy(e,cb){cb(e);}});
  // Failure may occur before bootstrap attaches its stream listeners.
  s.on('error',()=>{});return s;
 });
 function data(chunk){try{
  alive();total+=chunk.length;if(total>1048576||pending.length+chunk.length>2*LIMIT)throw Error('native aggregate input bound');
  pending=Buffer.concat([pending,chunk]);
  while(pending.length>=5){const lane=pending[0],n=pending.readUInt32BE(1);
   if(lane>2||n===0||n>(lane===0?LIMIT:CHUNK))throw Error('native frame read bound');
   if(pending.length<n+5)break;const body=Buffer.from(pending.subarray(5,5+n));pending=pending.subarray(5+n);
   if(lane===0){if(control)throw Error('unsolicited duplicate native control');if(waiter){const w=waiter;waiter=null;w.resolve(body);}else control=body;}
   else{const s=streams[lane-1];if(s.destroyed||s.readableLength+body.length>65536)throw Error('native lane backlog bound');s.push(body);}
  }
 }catch(e){close(e);}}
 input.on('data',data);input.on('end',ended);input.on('close',ended);input.on('error',close);output.on('error',close);signal.addEventListener('abort',aborted,{once:true});
 if(signal.aborted)aborted();
 return {monitor:streams[0],tpm:streams[1],sendControl:s=>send(0,Buffer.from(s)),
  receiveControl(){alive();if(waiter)throw Error('one native control waiter');if(control){const r=control;control=null;return Promise.resolve(r);}return new Promise((resolve,reject)=>{waiter={resolve,reject};});},close};
}

// Sample is taken by native AFTER our request. Adding the whole local roundtrip
// overestimates Windows time, so transport delay consumes time instead of adding
// it. Never assume Node hrtime and native QPC share their epoch or frequency.
export function mapNativeClock(receipt,before,now){
 const number=s=>{if(typeof s!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(s))throw Error('native decimal clock required');return BigInt(s)*1000000n;};
 if(receipt?.schema!=='rpc-native-clock/1'||typeof before!=='bigint'||typeof now!=='function')throw Error('native clock receipt required');
 const origin=number(receipt.originMs),deadline=number(receipt.deadlineMs),phase=number(receipt.phaseDeadlineMs),sample=number(receipt.sampleMs);
 if(deadline-origin!==900000000000n||sample<origin||sample>=phase||phase>deadline||phase-sample>30000000000n)throw Error('original native clock window differs');
 let last=before;
 const mapped=()=>{const n=now();if(typeof n!=='bigint'||n<last)throw Error('local monotonic clock regressed');last=n;return sample+n-before;};
 if(mapped()>=phase)throw Error('native handshake consumed phase deadline');
 return {original:{originMonotonicNs:origin,deadlineMonotonicNs:deadline},now:mapped,phaseDeadlineNs:phase};
}
