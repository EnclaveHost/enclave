// Same authenticated TLS socket <-> one original submit child. No retry or
// reconnect. The independent bootstrap unit and originalD remain authoritative.
import {reader,writeFrame} from './owner_bootstrap_transport.mjs';
import {persist} from './owner_bootstrap_session.mjs';

export async function forwardOwnerStream(session,connection,child){
 let rejectLost,closed=false,stderr=0;
 const lost=new Promise((_,reject)=>{rejectLost=reject;});lost.catch(()=>{});
 const fail=()=>{if(!closed)rejectLost(Error('Original owner stream lost; held'));};
 const onError=chunk=>{stderr+=chunk.length;if(stderr>8192)fail();};
 child.on('error',fail);child.on('exit',fail);child.stdout.on('end',fail);child.stdout.on('close',fail);
 child.stdin.on('error',fail);child.stderr.on('error',fail);
 child.stderr.on('data',onError);connection.socket.on('close',fail);connection.socket.on('error',fail);
 const read=reader(child.stdout,65536,true);
 const deadline=BigInt(session.original.deadlineMonotonicNs);
 const bounded=async(promise,ms)=>{
  promise.catch(()=>{});
  const left=Number((deadline-process.hrtime.bigint())/1000000n);
  if(left<=0)throw Error('Original owner deadline expired');
  let timer;
  try{return await Promise.race([promise,lost,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owner stream operation expired')),Math.min(ms,left));})]);}
  finally{clearTimeout(timer);}
 };
 try{
  if(child.exitCode!==null||child.signalCode!==null||connection.socket.destroyed)throw Error('Owner stream already lost');
  const initial=await bounded(read(65536),30000);
  const value=JSON.parse(initial);
  if(value.schema!=='enclave-rpc-owner-dispatched/2'||value.attempt!==session.original.attempt||
     ['rpcReady','writersFenced','reservationMayRelease'].some(k=>value[k]!==false))throw Error('Original dispatched/2 required');
  await bounded(writeFrame(connection.socket,initial),3000);
  for(let sequence=1;sequence<=90;sequence++){
   const raw=await bounded(connection.read(1024),30000);
   persist(session.directory,`continuation-${sequence.toString(16).padStart(16,'0')}-wire`,raw);
   // Arm exactly one response before writing: a fast child may answer before
   // the write callback. No idle speculative response may be buffered.
   const response=read(2048);response.catch(()=>{});
   await bounded(writeFrame(child.stdin,raw),3000);
   const proof=await bounded(response,3000);
   persist(session.directory,`continuation-${sequence.toString(16).padStart(16,'0')}-wire-response`,proof);
   await bounded(writeFrame(connection.socket,proof),3000);
  }
  throw Error('Original continuation count exhausted; held');
 }finally{
  closed=true;
  // Exact local child only. Reaping it does not prove remote dispatcher/signer
  // death or release any possibly submitted writer reservation.
  connection.socket.destroy();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
  child.kill('SIGKILL');
  child.removeListener('exit',fail);
  child.stdout.removeListener('end',fail);child.stderr.removeListener('data',onError);
  connection.socket.removeListener('close',fail);connection.socket.removeListener('error',fail);
 }
}
