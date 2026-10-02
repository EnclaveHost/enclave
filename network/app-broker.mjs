import http from 'node:http';
import fs from 'node:fs/promises';
import {WebSocketServer,createWebSocketStream} from 'ws';

// A separate Unix socket binds each sandbox to one deployment. It accepts no
// deployment selector, hostname selector or arbitrary upstream from that sandbox.
export async function createAppBroker({socketPath,deploymentId,authorize,forward,log=()=>{}}) {
  const server=http.createServer((_req,res)=>{res.writeHead(404);res.end();});
  server.maxConnections=1024;
  const wss=new WebSocketServer({noServer:true,maxPayload:1048576,perMessageDeflate:false});
  const sockets=new Set();
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/app'||!authorize(deploymentId)){socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      sockets.add(ws);ws.once('close',()=>sockets.delete(ws));ws.on('error',()=>ws.terminate());
      const stream=createWebSocketStream(ws);stream.on('error',()=>ws.terminate());
      Promise.resolve().then(()=>forward(stream,deploymentId)).catch(e=>{log('app broker: '+e.message);ws.terminate();});
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  await fs.chmod(socketPath,0o600);
  return {revoke(){for(const socket of sockets)socket.terminate();},async close(){for(const socket of sockets)socket.terminate();wss.close();await new Promise(r=>server.close(r));await fs.rm(socketPath,{force:true});}};
}
