// Finite TLS transport. The independent owner service must already be armed.
// First TCP connection consumes the listener, even on handshake failure.
import tls from 'node:tls';
import net from 'node:net';
import {X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import {persist,canonicalWire} from './owner_bootstrap_session.mjs';
import {sha256} from '../../isolation/contract/rpc-bootstrap.mjs';

export function reader(socket,maximum=12<<20){
 let data=Buffer.alloc(0),failure=null,ended=false,wake;
 socket.on('data',chunk=>{if(data.length+chunk.length>maximum+4){failure=Error('owner input bound');socket.destroy();}else data=Buffer.concat([data,chunk]);wake?.();});
 socket.on('error',e=>{failure=e;wake?.();});socket.on('end',()=>{ended=true;wake?.();});socket.on('close',()=>{ended=true;wake?.();});
 return async limit=>{
  for(;;){
   if(failure)throw failure;
   if(data.length>=4){const n=data.readUInt32BE();if(n===0||n>limit)throw Error('owner frame bound');if(data.length>=n+4){const raw=Buffer.from(data.subarray(4,4+n));data=data.subarray(4+n);return raw;}}
   if(ended)throw Error('owner frame incomplete');
   await new Promise(resolve=>{wake=resolve;});wake=null;
  }
 };
}
export async function writeFrame(socket,raw){
 if(!Buffer.isBuffer(raw)||!raw.length||raw.length>65536)throw Error('owner response bound');
 const frame=Buffer.alloc(raw.length+4);frame.writeUInt32BE(raw.length);raw.copy(frame,4);
 await new Promise((resolve,reject)=>socket.write(frame,e=>e?reject(e):resolve()));
}

export async function listenOwnerBootstrap(session,{host,port,key,cert}){
 if(net.isIP(host)===0)throw Error('explicit literal owner listener required');
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('explicit owner port required');
 const server=tls.createServer({key,cert,ca:new X509Certificate(session.clientCertificate).toString(),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',handshakeTimeout:3000,sessionTimeout:1});
 let used=false,peer,secure,closed=false,rejectPending,authTimer,lifetimeTimer;
 const close=(reason=Error('owner transport closed'))=>{
  if(closed)return;closed=true;
  clearTimeout(authTimer);clearTimeout(lifetimeTimer);
  rejectPending?.(reason);secure?.destroy(reason);peer?.destroy();server.close();session.close();
 };
 const finished=new Promise((resolve,reject)=>{
  rejectPending=reject;
  server.on('connection',socket=>{if(used||closed){socket.destroy();return;}used=true;peer=socket;server.close();});
  server.once('tlsClientError',close);server.once('error',close);
  server.once('secureConnection',async socket=>{
   secure=socket;
   // Keep a listener after authentication, including during dispatcher work.
   socket.on('error',()=>{});
   try{
    if(closed||!socket.authorized||socket.getProtocol()!=='TLSv1.3'||socket.isSessionReused())throw Error('fresh pinned client TLS required');
    const read=reader(socket),raw=await read(12<<20),actual=socket.getPeerCertificate(true).raw;
    const accepted=session.accept(raw,actual);
    await writeFrame(socket,Buffer.from(JSON.stringify(accepted)));
    clearTimeout(authTimer);resolve({socket,read,accepted});
   }catch(e){close(e);}
  });
 });
 finished.catch(()=>{}); // No unhandled rejection while caller awaits listen.
 const remaining=BigInt(session.original.deadlineMonotonicNs)-process.hrtime.bigint();
 if(remaining<=0n){close();throw Error('original owner window expired');}
 const ms=Math.max(1,Number(remaining/1000000n));
 authTimer=setTimeout(()=>close(Error('owner authentication deadline')),Math.min(30000,ms));
 // Absolute, never reset by bytes, authentication, dispatch or reconnect.
 lifetimeTimer=setTimeout(()=>close(Error('original owner transport deadline')),Math.min(100000,ms));
 server.listen({host,port,backlog:1});
 try{
  await once(server,'listening');
  persist(session.directory,'public-challenge.json',Buffer.from(JSON.stringify({...session.challenge(),host,port,serverCertificateSha256:sha256(new X509Certificate(cert).raw).toString('hex')})+'\n'));
 }catch(e){close(e);throw e;}
 return {server,accepted:finished,close};
}

export async function receivePreparedRequest(session,connection,prepared){
 // Three seconds for the complete request after authentication; no slow-drip
 // extension. The service and original transport timers remain independent.
 const timer=setTimeout(()=>connection.socket.destroy(Error('owner request deadline')),3000);
 try{
  const raw=await connection.read(4<<20);
  canonicalWire(raw,4<<20);
  if(!raw.equals(prepared))throw Error('owner wire differs from prepared request');
  if(process.hrtime.bigint()>=BigInt(session.original.deadlineMonotonicNs))throw Error('original owner deadline expired');
  persist(session.directory,'dispatch.intent',Buffer.from(JSON.stringify({requestSha256:connection.accepted.requestSha256,wireSha256:sha256(raw).toString('hex'),rootsGranted:false,rpcReady:false})+'\n'));
  return raw;
 }finally{clearTimeout(timer);}
}
