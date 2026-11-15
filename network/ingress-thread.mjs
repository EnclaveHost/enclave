// The agent's ingress data path on a thread of its own (ingress-thread-host.mjs starts it and says why).
//
// One broker here per circuit, as app-broker.mjs has them on the main thread: a loopback WebSocket server that the
// circuit's sandboxed worker reaches with the circuit's token. This thread decides nothing about admission: for every
// connection it asks the main thread, which answers with a route it has verified (the bytes are then spliced here to the
// partition manager's data plane, supervisor-splice.mjs openSplice), with "legacy" (the connection is handed, as it
// came, to the main thread's own broker for this circuit) or with a refusal. A revoke closes what is open.
import http from 'node:http';
import net from 'node:net';
import {timingSafeEqual} from 'node:crypto';
import {parentPort,workerData,isMainThread} from 'node:worker_threads';
import {WebSocketServer,createWebSocketStream} from 'ws';
import {openSplice} from '../isolation/m4/guestd/supervisor-splice.mjs';

const ASK_MS=15000;

export function startIngressThread(port,{open=openSplice}={}){
  const brokers=new Map(),waiting=new Map();let nextReq=1;
  const log=message=>port.postMessage({t:'log',message});
  const ask=id=>new Promise((resolve,reject)=>{
    const req=nextReq++,timer=setTimeout(()=>{waiting.delete(req);reject(new Error('the main thread did not answer'));},ASK_MS);
    waiting.set(req,{resolve,timer});port.postMessage({t:'open',id,req});
  });
  // a connection the main thread did not plan: its own broker takes it, upgrade request and all
  const legacy=(b,req,socket,head)=>{
    const up=net.connect({host:'127.0.0.1',port:b.legacyPort}),close=()=>{socket.destroy();up.destroy();};
    up.on('error',close);up.once('close',close);socket.once('close',close);
    up.once('connect',()=>{
      let h=`${req.method} ${req.url} HTTP/1.1\r\n`;for(let i=0;i<req.rawHeaders.length;i+=2)h+=`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`;
      up.write(h+'\r\n');if(head.length)up.write(head);socket.pipe(up).pipe(socket);socket.resume();
    });
  };
  const spliced=(b,req,socket,head,plan)=>b.wss.handleUpgrade(req,socket,head,ws=>{
    ws.on('error',()=>ws.terminate());
    const stream=createWebSocketStream(ws);stream.on('error',()=>ws.terminate());
    Promise.resolve().then(()=>open(plan.dataAddr,plan.route)).then(guest=>{
      if(stream.destroyed||socket.destroyed){guest.destroy();return;}
      guest.setNoDelay(true);
      const close=()=>{stream.destroy();guest.destroy();ws.terminate();};
      stream.on('error',close);guest.on('error',close);stream.once('close',close);guest.once('close',close);
      stream.pipe(guest).pipe(stream);stream.resume();
    }).catch(e=>{log('app broker: '+e.message);ws.terminate();});
  });
  const create=({id,token,legacyPort})=>{
    const refuse=message=>port.postMessage({t:'failed',id,message});
    if(brokers.has(id)||!/^[a-f0-9]{64}$/.test(token||'')||!Number.isInteger(legacyPort)||legacyPort<1||legacyPort>65535)return refuse('explicit broker required');
    const server=http.createServer((_req,res)=>{res.writeHead(404);res.end();});server.maxConnections=1024;
    const b={server,wss:new WebSocketServer({noServer:true,maxPayload:1048576,perMessageDeflate:false}),sockets:new Set(),token:Buffer.from(token),legacyPort};
    server.on('upgrade',(req,socket,head)=>{
      const given=req.headers['x-enclave-broker'];
      if(req.url!=='/app'||typeof given!=='string'||!/^[a-f0-9]{64}$/.test(given)||!timingSafeEqual(Buffer.from(given),b.token)){socket.destroy();return;}
      b.sockets.add(socket);socket.once('close',()=>b.sockets.delete(socket));socket.on('error',()=>socket.destroy());
      ask(id).then(a=>{
        if(socket.destroyed||brokers.get(id)!==b)return socket.destroy();
        if(a.plan)spliced(b,req,socket,head,a.plan);else if(a.legacy===true)legacy(b,req,socket,head);else socket.destroy();
      },()=>socket.destroy());
    });
    server.once('error',e=>{brokers.delete(id);refuse(e.message);});
    brokers.set(id,b);server.listen(0,'127.0.0.1',()=>port.postMessage({t:'listening',id,port:server.address().port}));
  };
  port.on('message',m=>{
    if(m?.t==='create')return create(m);
    if(m?.t==='answer'){const w=waiting.get(m.req);if(w){waiting.delete(m.req);clearTimeout(w.timer);w.resolve(m);}return;}
    const b=brokers.get(m?.id);if(!b)return;
    if(m.t==='revoke'||m.t==='close')for(const s of b.sockets)s.destroy();
    if(m.t==='close'){brokers.delete(m.id);b.wss.close();b.server.close();}
  });
}
if(!isMainThread&&workerData?.enclaveIngressThread===1)startIngressThread(parentPort);
