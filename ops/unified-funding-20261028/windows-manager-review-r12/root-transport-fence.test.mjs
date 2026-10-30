// ROOT regression: real ProtectedIsolationClient -> real GuestdControl handshake/MAC -> real ControlServer over loopback HTTP.
// TEST destination handler counts authorized mutation arrivals then refuses them; no VM/chain/wallet. TEST policy flips while the
// real session response is delayed. A refusal before the handshake does not establish a refusal at the last send boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {GuestdControl} from './repaired/control/isolation/m4/guestd/control-client.mjs';
import {ControlServer} from './repaired/control/windows/vbslike/manager/control.mjs';
import {ProtectedIsolationClient} from './repaired/control/windows/node/protected-isolation.mjs';
const DEP='0x'+'d1'.repeat(32), ID='pp'+'01'.repeat(16);
for (const op of ['stage','permit']) for (const revoked of [false,true]) {
 test(`ROOT ${op}: ${revoked?'policy revoked during handshake blocks mutation':'unchanged policy reaches authenticated destination'}`,async(t)=>{
  let policy=null,arrivals=0;
  let entered,release;
  const waiting=new Promise(r=>entered=r), held=new Promise(r=>release=r);
  const key=Buffer.alloc(32,7);
  const auth=new ControlServer({key,handle:async()=>{arrivals++;return {status:409,body:{error:'TEST destination refused'}};}});
  const server=http.createServer(async(req,res)=>{
   try {
    let body='';for await(const b of req)body+=b;
    let out;
    if(req.url==='/control/hello')out=auth.hello();
    else if(req.url==='/control/session'){out=auth.session(JSON.parse(body));entered();await held;}
    else out=await auth.call({method:req.method,path:req.url,headers:req.headers,body});
    res.writeHead(out.status,{'content-type':'application/json',...out.headers});res.end(JSON.stringify(out.body));
   }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{release();server.closeAllConnections();server.close();});
  const client=new ProtectedIsolationClient({control:new GuestdControl(`http://127.0.0.1:${server.address().port}`,key),newWorkRefusal:()=>policy});
  const pending=(op==='stage'?client.stage({deployment:DEP,stagingMs:5000,spawn:{}}):client.permit(ID,{}, {deployment:DEP})).then(()=>null,e=>e);
  await waiting;if(revoked)policy='TEST owner revoked admission';release();
  const error=await pending;assert.ok(error,'the TEST handler always refuses, or the local fence refuses before it');
  assert.equal(arrivals,revoked?0:1,'only unchanged policy may reach the authenticated mutation handler');
  if(revoked){assert.equal(error.notSent,true);assert.equal(error.mayHaveExecuted,false);}
 });
}
