// The provider's control API (TCP; every request and grant is signed, so the transport needs no secrecy):
//   POST /v1/peer   {request, signature} -> {grant, signature}
//   POST /v1/revoke {request, signature} -> {revoked}   (a host withdrawing its own service/control peer, provider.mjs revoke)
//   GET  /v1/info   public description of this provider
//   POST /v1/receipt {receipt, runnerSignature, anchorHash} -> {signature}   (a paid provider's co-signature, paid.mjs)
import http from 'node:http';

export async function createControl({provider,info,receipt=null,port,host='0.0.0.0',perMinute=120,log=()=>{}}){
 const buckets=new Map();
 const limited=ip=>{const now=Date.now(),b=buckets.get(ip)||{n:0,at:now};if(now-b.at>60000){b.n=0;b.at=now;}b.n++;buckets.set(ip,b);if(buckets.size>10000)buckets.clear();return b.n>perMinute;};
 const send=(res,status,body)=>{const s=JSON.stringify(body);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(s),'cache-control':'no-store'});res.end(s);};
 const server=http.createServer((req,res)=>{
  req.setTimeout(10000,()=>req.destroy());
  if(limited(req.socket.remoteAddress||''))return send(res,429,{error:'too many requests'});
  if(req.method==='GET'&&req.url==='/v1/info')return send(res,200,{...info(),status:provider.status()});
  const route=req.method==='POST'&&(req.url==='/v1/peer'?'peer':req.url==='/v1/revoke'&&provider.revoke?'revoke':req.url==='/v1/receipt'&&receipt?'receipt':null);
  if(!route)return send(res,404,{error:'not found'});
  const parts=[];let size=0;
  req.on('data',c=>{size+=c.length;if(size>16384){send(res,413,{error:'request too large'});req.destroy();}else parts.push(c);});
  req.on('end',async()=>{
   if(res.headersSent)return;
   let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{return send(res,400,{error:'JSON required'});}
   try{send(res,200,route==='peer'?await provider.handle(body):route==='revoke'?await provider.revoke(body):await receipt(body));}
   catch(e){log(`${route} refused: ${e.message}`);send(res,403,{error:e.message.slice(0,300)});}
  });
 });
 server.headersTimeout=10000;server.requestTimeout=15000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
 return {port:server.address().port,close(){server.close();}};
}
