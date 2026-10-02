import https from 'node:https';
import tls from 'node:tls';
import WebSocket, {createWebSocketStream} from 'ws';
import {localUpstream} from './agent.mjs';

// This transport binds a verifier to a single local deployment. It performs no
// hostname lookup, public dial, SNI routing or caller-supplied deployment choice.
export function openLocalApp(upstream, deploymentId) {
  const origin=localUpstream(upstream);
  if(!/^0x[0-9a-f]{64}$/.test(deploymentId))throw new Error('exact app identity required');
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(origin.replace(/^http/,'ws')+'/x/'+deploymentId+'/https',
      {handshakeTimeout:10000,maxPayload:1048576,perMessageDeflate:false});
    ws.on('error',()=>{});ws.once('error',reject);
    ws.once('unexpected-response',(_request,response)=>{response.resume();ws.terminate();reject(new Error('local ingress HTTP '+response.statusCode));});
    ws.once('open',()=>{
      const stream=createWebSocketStream(ws);stream.on('error',()=>ws.terminate());
      stream.once('close',()=>ws.terminate());resolve(stream);
    });
  });
}
export function localAppForwarder(upstream) {
  localUpstream(upstream);
  return async (socket,id)=>{
    const stream=await openLocalApp(upstream,id);
    if(socket.destroyed){stream.destroy();return;}
    const close=()=>{socket.destroy();stream.destroy();};
    stream.on('error',close);socket.on('error',close);stream.once('close',close);socket.once('close',close);
    socket.pipe(stream).pipe(socket);socket.resume();
  };
}
export class LocalAppHttpsAgent extends https.Agent {
  constructor(upstream,deploymentId,{openApp}={}){super({keepAlive:false,maxSockets:4});this.upstream=openApp?null:localUpstream(upstream);this.deploymentId=deploymentId;this.openApp=openApp||((id)=>openLocalApp(this.upstream,id));}
  createConnection(options,callback){
    this.openApp(this.deploymentId).then(socket=>{
      const connection=tls.connect({...options,socket});let settled=false;
      const done=error=>{if(settled)return;settled=true;clearTimeout(timer);if(error){connection.destroy();callback(error);}else callback(null,connection);};
      const timer=setTimeout(()=>done(new Error('local guest TLS timeout')),15000);
      connection.once('secureConnect',()=>done());connection.once('error',done);
    },callback);
  }
}
