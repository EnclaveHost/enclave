import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import fs from 'node:fs/promises';
import {WebSocketServer,createWebSocketStream} from 'ws';

// A separate Unix socket binds each sandbox to one deployment. It accepts no
// deployment selector, hostname selector or arbitrary upstream from that sandbox.
export async function createAppBroker({socketPath,tcpPort,token,deploymentId,authorize,forward,log=()=>{}}) {
  const tcp=tcpPort!==undefined;
  if(tcp?(socketPath!==undefined||!Number.isInteger(tcpPort)||tcpPort<0||tcpPort>65535||!/^([a-f0-9]{64})$/.test(token||'')):(typeof socketPath!=='string'||!socketPath))throw new Error('explicit app broker IPC transport required');
  const matchesToken=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&timingSafeEqual(Buffer.from(value),Buffer.from(token));
  const server=http.createServer((_req,res)=>{res.writeHead(404);res.end();});
  server.maxConnections=1024;
  const wss=new WebSocketServer({noServer:true,maxPayload:1048576,perMessageDeflate:false});
  const sockets=new Set();
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/app'||(tcp&&!matchesToken(req.headers['x-enclave-broker']))||!authorize(deploymentId)){socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      sockets.add(ws);ws.once('close',()=>sockets.delete(ws));ws.on('error',()=>ws.terminate());
      const stream=createWebSocketStream(ws);stream.on('error',()=>ws.terminate());
      Promise.resolve().then(()=>forward(stream,deploymentId)).catch(e=>{log('app broker: '+e.message);ws.terminate();});
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);if(tcp)server.listen(tcpPort,'127.0.0.1',resolve);else server.listen(socketPath,resolve);});
  if(!tcp)await fs.chmod(socketPath,0o600);
  return {...(tcp?{port:server.address().port}:{}),revoke(){for(const socket of sockets)socket.terminate();},async close(){for(const socket of sockets)socket.terminate();wss.close();await new Promise(r=>server.close(r));if(!tcp)await fs.rm(socketPath,{force:true});}};
}
