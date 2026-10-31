import test from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import http from 'node:http';import {once} from 'node:events';
import {controlServer,dataServer,makeRequest} from './io.mjs';
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function tcpFixture(t,reply='OK\n'){
 const seen=[],sockets=new Set();
 const server=net.createServer(s=>{sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));let data=Buffer.alloc(0);s.on('data',b=>{data=Buffer.concat([data,b]);if(data.includes(Buffer.from('PAYLOAD'))){seen.push(data);s.end(reply);}});});
 const port=await listen(server);t.after(()=>{for(const s of sockets)s.destroy();server.close();});return {port,seen};
}
async function exchange(port,data,{chunks=false}={}){
 const s=net.connect(port,'127.0.0.1');s.on('error',()=>{});s.setTimeout(2000,()=>s.destroy(Error('deadline')));await once(s,'connect');
 let out=Buffer.alloc(0);s.on('data',b=>{out=Buffer.concat([out,b]);});const finished=new Promise(resolve=>s.once('close',()=>resolve(out)));
 if(chunks){for(const b of data){s.write(Buffer.from([b]));await new Promise(r=>setImmediate(r));}}else s.write(data);
 return finished;
}
const preamble=id=>`ENCLAVE-SPLICE/1 id=${id} app=${'1'.repeat(64)} image=${'2'.repeat(64)} runtime=${'3'.repeat(64)} key=${'4'.repeat(64)}\nPAYLOAD`;
for(const native of [false,true])test((native?'native':'legacy')+' ciphertext is forwarded unchanged to correct data plane',async t=>{
 const old=await tcpFixture(t),next=await tcpFixture(t),router=dataServer({legacyPort:old.port,nativePort:next.port}),port=await listen(router.server);t.after(router.close);
 const raw=Buffer.from(preamble(native?'nd'+'a'.repeat(32):'hv-existing'));
 assert.equal((await exchange(port,raw,{chunks:true})).toString(),'OK\n');
 assert.deepEqual((native?next:old).seen,[raw]);assert.equal((native?old:next).seen.length,0);
});
test('backend rejection is relayed; router never replaces NO with OK',async t=>{
 const old=await tcpFixture(t,'NO wrong key\n'),next=await tcpFixture(t),router=dataServer({legacyPort:old.port,nativePort:next.port}),port=await listen(router.server);t.after(router.close);
 assert.equal((await exchange(port,Buffer.from(preamble('hv-existing')))).toString(),'NO wrong key\n');
});
for(const [label,raw] of [['malformed protocol','BAD\nPAYLOAD'],['oversized preamble','x'.repeat(513)],['invalid namespace',preamble('nd-invalid')],['extra identity field',preamble('hv-id').replace('\n',' other=foo\n')]])test(label+' never reaches either backend',async t=>{
 const old=await tcpFixture(t),next=await tcpFixture(t),router=dataServer({legacyPort:old.port,nativePort:next.port,preambleMs:50}),port=await listen(router.server);t.after(router.close);
 assert.equal((await exchange(port,Buffer.from(raw))).length,0);assert.equal(old.seen.length+next.seen.length,0);
});
test('preamble deadline closes idle connection',async t=>{
 const old=await tcpFixture(t),router=dataServer({legacyPort:old.port,nativePort:old.port,preambleMs:40}),port=await listen(router.server);t.after(router.close);
 assert.equal((await exchange(port,Buffer.from('ENCLAVE'))).length,0);
});
test('HTTP adapter preserves callback body and authentication header byte-for-byte',async t=>{
 let received;const backend=http.createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);received={body:Buffer.concat(chunks),header:req.headers['x-enclave-custody-callback'],path:req.url};res.end('{"ok":true}');});
 const bp=await listen(backend);t.after(()=>{backend.closeAllConnections();backend.close();});
 const request=makeRequest({legacyPort:bp,nativePort:bp});
 const server=controlServer({handle:(method,path,body,headers)=>request('legacy',method,path,body,headers)}),port=await listen(server);t.after(()=>{server.closeAllConnections();server.close();});
 const raw=Buffer.from('{ "signature" : "fixture" }\n');
 const response=await fetch(`http://127.0.0.1:${port}/vms/hv1/custody-auth`,{method:'POST',body:raw,headers:{'x-enclave-custody-callback':'v1 fixture','content-type':'application/json'}});
 assert.equal(response.status,200);assert.deepEqual(received.body,raw);assert.equal(received.header,'v1 fixture');assert.equal(received.path,'/vms/hv1/custody-auth');
});
test('HTTP request bound rejects body without manager mutation',async t=>{
 let calls=0;const server=controlServer({handle:()=>{calls++;return {status:200,body:{}};}},{maxBytes:16});const port=await listen(server);t.after(()=>{server.closeAllConnections();server.close();});
 try{const r=await fetch(`http://127.0.0.1:${port}/vms`,{method:'POST',body:'x'.repeat(100)});assert.equal(r.status,413);}catch(e){assert.equal(e.message,'fetch failed');}
 assert.equal(calls,0);
});
test('upstream deadline covers response body, not only headers',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(200);res.write('{');});const port=await listen(server);t.after(()=>{server.closeAllConnections();server.close();});
 const request=makeRequest({legacyPort:port,nativePort:port,timeoutMs:40});await assert.rejects(request('legacy','GET','/health'),/deadline/);
});
test('HTTP adapter keeps encoded callback path, query, trailing slash and raw response bytes',async t=>{
 const rawResponse=Buffer.from('{ "counter":9007199254740993, "ok": true }\n');let received;
 const backend=http.createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);received={path:req.url,body:Buffer.concat(chunks)};res.end(rawResponse);});
 const bp=await listen(backend);t.after(()=>{backend.closeAllConnections();backend.close();});
 const request=makeRequest({legacyPort:bp,nativePort:bp}),server=controlServer({handle:(m,p,b,h)=>request('legacy',m,p,b,h)}),port=await listen(server);t.after(()=>{server.closeAllConnections();server.close();});
 const p='/vms/%68v1/custody-auth/?test=1',body=Buffer.from(' { "signed":true }\n');
 const r=await fetch(`http://127.0.0.1:${port}${p}`,{method:'POST',body});
 assert.equal(received.path,p);assert.deepEqual(received.body,body);assert.deepEqual(Buffer.from(await r.arrayBuffer()),rawResponse);
});


test('three data routes preserve exact preamble and payload, with no fallback on refusal',async t=>{
 const old=await tcpFixture(t),native=await tcpFixture(t),enrolled=await tcpFixture(t,'NO original backend refusal\n');
 const router=dataServer({legacyPort:old.port,nativePort:native.port,enrolledPort:enrolled.port});
 const port=await listen(router.server);t.after(router.close);
 for(const [id,target,response] of [['hv-old',old,'OK\n'],['nd'+'a'.repeat(32),native,'OK\n'],['nx'+'b'.repeat(32),enrolled,'NO original backend refusal\n']]){
  const raw=Buffer.from(preamble(id));assert.equal((await exchange(port,raw)).toString(),response);assert.deepEqual(target.seen,[raw]);
 }
 assert.equal((await exchange(port,Buffer.from(preamble('nx-bad')))).length,0);
 assert.equal(old.seen.length+native.seen.length+enrolled.seen.length,3);
});
