import http from 'node:http';
import fs from 'node:fs/promises';
import net from 'node:net';
import {timingSafeEqual} from 'node:crypto';

export async function startTunaControlServer({controller,token,socketPath,port=0,log=()=>{},intervalMs=5000,scope,ownsController=true}){
 if(!/^[0-9a-f]{64}$/.test(token||'')||(intervalMs!==0&&intervalMs<1000)||intervalMs>10000||ownsController&&intervalMs===0)throw Error('private transport control token and refresh interval required');
 const expected=Buffer.from('Bearer '+token);let closed=false,pending=null;const sessions=new Set();
 if(scope&&(!/^0x[0-9a-f]{64}$/.test(scope.deploymentId)||!/^0x[0-9a-f]{64}$/.test(scope.providerId)))throw Error('invalid transport control scope');
 const actions=new Set(['open','confirm','reserve','commit','remote','next','reply','close']);
 const server=http.createServer({maxHeaderSize:4096,requestTimeout:30000,headersTimeout:5000},async(req,res)=>{
  try{
   const auth=Buffer.from(req.headers.authorization||'');
   if(closed||req.method!=='POST'||req.url!=='/'||auth.length!==expected.length||!timingSafeEqual(auth,expected)){res.writeHead(403);res.end();return;}
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>32768)throw Error('control request too large');chunks.push(chunk);}
   const {action,session,body}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!actions.has(action)||action!=='open'&&!/^[0-9a-f]{48}$/.test(session||''))throw Error('invalid control operation');
   let result;
   if(action==='open'){
    if(scope&&(body?.deploymentId!==scope.deploymentId||body?.providerId!==scope.providerId||body?.transcript?.server!==false))throw Error('transport request outside worker scope');
    result=await controller.open(body);sessions.add(result.session);
   }
   else {
    if(!sessions.has(session))throw Error('transport session outside worker scope');
    if(action==='close'){result=controller.drop(session);sessions.delete(session);}
    else result=await controller[action](session,body);
   }
   const raw=JSON.stringify(result,(_k,v)=>typeof v==='bigint'?String(v):v);
   if(Buffer.byteLength(raw)>16384)throw Error('control response too large');
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(raw);
  }catch(e){log('USDC transport: '+e.message);if(!res.headersSent)res.writeHead(409);res.end('{}');}
 });
 server.on('clientError',(_e,s)=>s.destroy());
 if(socketPath){
  if(!socketPath.startsWith('/'))throw Error('absolute private controller socket required');
  // Never unlink an existing socket: it may belong to a live controller.
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve)});await fs.chmod(socketPath,0o600);
 }else{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});
  if(!net.isIP(server.address().address))throw Error('literal controller address required');
 }
 const tick=()=>{if(closed||pending)return;pending=controller.tick().catch(e=>log('USDC transport: '+e.message)).finally(()=>{pending=null;});};
 const timer=intervalMs?setInterval(tick,intervalMs):null;timer?.unref();
 return {socketPath,port:server.address().port,async close(){if(closed)return;closed=true;clearInterval(timer);for(const id of sessions)controller.drop(id);if(ownsController)await controller.close();await pending;await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections()});}};
}
