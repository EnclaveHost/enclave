import net from 'node:net';
import WebSocket,{createWebSocketStream} from 'ws';

export async function spliceAppBroker(socket,socketPath) {
  const tcp=typeof socketPath==='object'&&socketPath!==null;
  if(tcp?(!Number.isInteger(socketPath.port)||socketPath.port<1||socketPath.port>65535||!/^[a-f0-9]{64}$/.test(socketPath.token||'')):(typeof socketPath!=='string'||!socketPath.length))throw new Error('app IPC socket required');
  // ws intentionally discards socketPath in its normal URL options. Supplying
  // createConnection makes the selected IPC transport mandatory. Windows TCP
  // is explicit, loopback-only, authenticated, and separately restricted by WFP.
  const ws=new WebSocket('ws://localhost/app',{createConnection:()=>tcp?net.connect({host:'127.0.0.1',port:socketPath.port}):net.connect({path:socketPath}),
    ...(tcp?{headers:{'x-enclave-broker':socketPath.token}}:{}),
    handshakeTimeout:10000,maxPayload:1048576,perMessageDeflate:false});
  ws.on('error',()=>socket.destroy());socket.once('close',()=>ws.terminate());
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);ws.once('unexpected-response',(_req,res)=>{res.resume();reject(new Error('app broker refused'));ws.terminate();});});
  if(socket.destroyed){ws.terminate();return;}
  const stream=createWebSocketStream(ws);stream.on('error',()=>socket.destroy());
  stream.once('close',()=>socket.destroy());socket.once('close',()=>stream.destroy());socket.pipe(stream).pipe(socket);socket.resume();
}
