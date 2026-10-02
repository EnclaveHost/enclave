import net from 'node:net';
import WebSocket,{createWebSocketStream} from 'ws';

export async function spliceAppBroker(socket,socketPath) {
  if(typeof socketPath!=='string'||!socketPath.length)throw new Error('app IPC socket required');
  // ws intentionally discards socketPath in its normal URL options. Supplying
  // createConnection makes IPC mandatory on both Unix sockets and named pipes;
  // there is no localhost TCP or DNS fallback.
  const ws=new WebSocket('ws://localhost/app',{createConnection:()=>net.connect({path:socketPath}),
    handshakeTimeout:10000,maxPayload:1048576,perMessageDeflate:false});
  ws.on('error',()=>socket.destroy());socket.once('close',()=>ws.terminate());
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);ws.once('unexpected-response',(_req,res)=>{res.resume();reject(new Error('app broker refused'));ws.terminate();});});
  if(socket.destroyed){ws.terminate();return;}
  const stream=createWebSocketStream(ws);stream.on('error',()=>socket.destroy());
  stream.once('close',()=>socket.destroy());socket.once('close',()=>stream.destroy());socket.pipe(stream).pipe(socket);socket.resume();
}
