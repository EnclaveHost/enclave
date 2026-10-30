import http from 'node:http';
import net from 'node:net';
import {parsePreamble,MAX_PREAMBLE} from '../datapath/datapath.mjs';
import {routeFor,routePath} from './control.mjs';

// Fixed numeric loopback endpoints only. No URL or destination from a request
// can select an upstream; the original managers remain authorization owners.
export function makeRequest({legacyPort,nativePort,timeoutMs=null,maxBytes=2*1024*1024}) {
  for(const port of [legacyPort,nativePort])if(!Number.isInteger(port)||port<1||port>65535)throw Error('invalid manager port');
  return (role,method,path,body,headers={})=>new Promise((resolve,reject)=>{
    if(!['legacy','native'].includes(role))return reject(Error('invalid manager role'));
    const raw=body===undefined?null:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
    if(raw && raw.length>maxBytes)return reject(Error('manager request too large'));
    const pass={};for(const key of ['content-type','x-enclave-custody-callback'])if(headers[key]!==undefined)pass[key]=headers[key];
    if(raw){pass['content-length']=raw.length;pass['content-type']??='application/json';}
    const req=http.request({hostname:'127.0.0.1',port:role==='native'?nativePort:legacyPort,method,path,headers:pass},res=>{
      const chunks=[];let count=0;
      res.on('data',chunk=>{count+=chunk.length;if(count>maxBytes)req.destroy(Error('manager response too large'));else chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{clearTimeout(timer);try{resolve({status:res.statusCode,raw:Buffer.concat(chunks),body:JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')});}catch{reject(Error('manager response is not JSON'));}});
    });
    const timer=setTimeout(()=>req.destroy(Error('manager exchange deadline')),timeoutMs??(method==='GET'?10000:125000));
    req.on('error',e=>{clearTimeout(timer);reject(e);});
    req.end(raw);
  });
}

export function controlServer(manager,{maxBytes=2*1024*1024,timeoutMs=150000,maxRequests=32}={}) {
  let active=0;
  const server=http.createServer(async(req,res)=>{
    const send=(status,body,raw)=>{if(res.destroyed)return;const bytes=raw??Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json','content-length':bytes.length});res.end(bytes);};
    if(active>=maxRequests){send(503,{error:'router busy'});req.resume();return;}
    active++;
    try{
      const route=routePath(req.url);
      if(route.custody && (req.headers['transfer-encoding'] || !Number.isSafeInteger(Number(req.headers['content-length'])) || Number(req.headers['content-length'])<0))return send(413,{error:'custody callback requires explicit length'});
      const chunks=[];let n=0;
      for await(const c of req){n+=c.length;if(n>maxBytes){send(413,{error:'manager request too large'});req.destroy();return;}chunks.push(c);}
      let body;const raw=Buffer.concat(chunks);
      if(route.custody)body=raw;
      else if(raw.length){try{body=JSON.parse(raw.toString('utf8'));}catch{return send(400,{error:'invalid JSON'});}}
      const reply=await manager.handle(req.method,req.url,body,req.headers);send(reply.status,reply.body,reply.raw);
    }catch(e){send(e.status||503,{error:e.message});}
    finally{active--;}
  });
  server.requestTimeout=timeoutMs;server.headersTimeout=Math.min(timeoutMs,10000);server.setTimeout(timeoutMs,s=>s.destroy());
  return server;
}

export function dataServer({legacyPort,nativePort,preambleMs=5000,dialMs=5000,idleMs=180000,maxConnections=1024}) {
  for(const port of [legacyPort,nativePort])if(!Number.isInteger(port)||port<1||port>65535)throw Error('invalid data port');
  const connections=new Set();
  const server=net.createServer(client=>{
    if(connections.size>=maxConnections){client.destroy();return;}
    connections.add(client);let upstream=null,head=Buffer.alloc(0),settled=false;
    const close=()=>{client.destroy();upstream?.destroy();connections.delete(client);clearTimeout(timer);};
    const timer=setTimeout(close,preambleMs);
    client.on('error',close);client.once('close',close);client.setNoDelay(true);
    const onData=chunk=>{
      if(settled)return;
      if(head.length+chunk.length>65536+MAX_PREAMBLE){close();return;}
      head=Buffer.concat([head,chunk]);const nl=head.indexOf(10);
      if(nl<0){if(head.length>MAX_PREAMBLE)close();return;}
      settled=true;clearTimeout(timer);client.off('data',onData);client.pause();
      if(nl>MAX_PREAMBLE){close();return;}
      let role;try{role=routeFor(parsePreamble(head.subarray(0,nl).toString('latin1')).id);}catch{close();return;}
      upstream=net.connect({host:'127.0.0.1',port:role==='native'?nativePort:legacyPort});
      const dial=setTimeout(close,dialMs);
      upstream.on('error',close);upstream.once('close',()=>{clearTimeout(dial);close();});
      upstream.once('connect',()=>{
        clearTimeout(dial);if(client.destroyed){close();return;}
        // Send the unchanged preamble. The destination manager checks all five
        // identity fields and returns its own OK/NO; this router never invents OK.
        upstream.write(head);head=null;upstream.setNoDelay(true);
        client.setTimeout(idleMs,close);upstream.setTimeout(idleMs,close);
        client.pipe(upstream);upstream.pipe(client);client.resume();
      });
    };
    client.on('data',onData);
  });
  return {server,close:()=>{for(const client of connections)client.destroy();server.close();},size:()=>connections.size};
}
