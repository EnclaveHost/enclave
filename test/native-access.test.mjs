import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import {Readable} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,X509Certificate,createHash} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {WebSocketServer} from 'ws';
import {NativeClient} from '../network/native-client.mjs';
import {signProviderRecord,signQualification,providerIdFor,CHECKS} from '../network/provider-directory.mjs';
import {defaultNetworkPolicy} from '../network/network-policy.mjs';
import {signDelegation,signRoute,recordHash} from '../network/route-record.mjs';
import {runtimeId} from '../isolation/contract/runtime.mjs';
import {bridge,parseArgs as wsArgs} from '../scripts/network/native-ws.mjs';
import {run as runRequest} from '../scripts/network/native-request.mjs';

// The current native transport path end to end: signed directory records, real TLS
// with a self-signed (non-WebPKI) guest key, a real WebSocket server and real HTTP
// streaming. The hardware verdict and chain reads are test doubles, as in
// native-client.test.mjs; this proves the client's transport, not SNP hardware.
const account=n=>privateKeyToAccount('0x'+n.repeat(64));
const owner=account('1'),operator=account('2'),checker=account('3');
const id='0x'+'ab'.repeat(32),runner='0x'+'cd'.repeat(32),address='8.8.4.4';
const runtime={name:'wasmtime',version:'test',execution:'jit',hostIsa:'x86_64',targetIsa:'x86_64',cpuFeatures:'baseline',wx:'enforced',cache:'none'};
const AUTH={Authorization:'Bearer private-test-only'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(f,ms=3000)=>{for(const end=Date.now()+ms;!f();){if(Date.now()>end)throw Error('condition not reached');await sleep(10);}};
const keypair=dir=>{
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=not-a-trusted-ca','-days','1','-keyout',dir+'/key','-out',dir+'/cert'],{stdio:'ignore'});
  const cert=fs.readFileSync(dir+'/cert'),key=fs.readFileSync(dir+'/key');
  return {cert,key,spki:createHash('sha256').update(new X509Certificate(cert).publicKey.export({format:'der',type:'spki'})).digest('hex')};
};

async function rig(t,{onSocket=null,onUpgrade=null,onRequest=null,clientOptions={}}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-access-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(dir+'/guest');fs.mkdirSync(dir+'/forged');
  const guest=keypair(dir+'/guest'),forged=keypair(dir+'/forged');
  // probe: 'ok' | 'refuse' | 'wrong app'; forged: the server presents a different key than the attested one.
  const state={probe:'ok',forged:false,withdraw:false,onRefresh:null};
  let now=Date.now(),reads=0,dirReads=0,probes=0,requests=0,upgrades=0,appBytes=0;const policy=defaultNetworkPolicy(id);
  const expected={appRef:'test-app',configCid:'test-config',appSha256:'ef'.repeat(32),runtimeId:runtimeId(runtime).toString('hex')};
  const pins={deployments:'0x'+'05'.repeat(20),registry:'0x'+'06'.repeat(20),connectivity:'0x'+'00'.repeat(20),sessionVaultFactory:'0x'+'00'.repeat(20)};
  const lease={id,owner:owner.address,runner,chainId:8453,deployments:pins.deployments,runnerOperator:operator.address,active:true,isPublic:true,leaseUntil:now+600000,validUntil:now+90000,appRef:expected.appRef,configCid:expected.configCid,blockNumber:'1234'};
  const record={version:1,providerId:providerIdFor(operator.address,address),operator:operator.address.toLowerCase(),address,
    wgExitKey:Buffer.alloc(32,1).toString('base64'),wgGuardKey:Buffer.alloc(32,2).toString('base64'),ports:{exit:51820,guard:51821,control:51822},
    roles:['guard','ingress','egress'],pricePerGiB6:0,region:'test',kind:'community',hostId:runner,issuedAt:now,expiresAt:now+1800000};
  const pr=await signProviderRecord(operator,record),q={version:1,providerId:record.providerId,operator:record.operator,address,wgExitKey:record.wgExitKey,wgGuardKey:record.wgGuardKey,roles:record.roles,
    checks:Object.fromEntries(CHECKS.map(k=>[k,true])),issuedAt:now,expiresAt:now+600000};
  const qualification=await signQualification(checker,q),keys=generateKeyPairSync('ed25519');
  const delegation={version:2,deploymentId:id,runner,chainId:8453,deployments:pins.deployments,policyHash:recordHash(policy),epoch:now,notBefore:now,expiresAt:now+3600000,
    publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),ipns:'k51'+'a'.repeat(50)};
  const authorization=await signDelegation(operator,delegation,now);
  const publication=(sequence,withdraw=false)=>({version:2,policy,bundle:{authorization,...signRoute(keys.privateKey,{version:2,deploymentId:id,delegationHash:recordHash(delegation),sequence,issuedAt:now,expiresAt:now+60000,
    routes:withdraw?[]:[{circuit:'f'.repeat(32),address,port:443,transport:'enclave-network'}]})}});
  const live={version:1,providers:[{record:pr,qualifications:[qualification]}],policies:[],publications:[publication(1)]};
  const withdrawn={...live,publications:[publication(2,true)]};
  const profile={version:1,deploymentId:id,hostname:'never-resolve.invalid',stateDir:dir+'/state',chainId:8453,expected,linux:{},authorityPins:pins,checkers:[checker.address],directories:['http://192.0.2.2:8188']};
  const reader={refresh:async()=>{reads++;state.onRefresh?.(reads,lease);},get:()=>structuredClone(lease),registryEntries:async()=>[{active:true,operator:operator.address}]};
  const fetch=async url=>{dirReads++;assert.ok(url.startsWith('http://192.0.2.2:8188/v1/network/records'));return Response.json(state.withdraw?withdrawn:live);};
  const probe=async options=>{
    probes++;assert.equal(options.address,address);assert.equal(options.hostname,profile.hostname);assert.equal(options.attestationBootstrap,true);
    if(state.probe==='refuse')throw Error('hardware refused');
    return {verified:true,ready:true,deploymentId:id,appSha256:state.probe==='wrong app'?'00'.repeat(32):expected.appSha256,runtimeId:expected.runtimeId,spkiSha256:guest.spki};
  };
  const contexts={guest:tls.createSecureContext({key:guest.key,cert:guest.cert}),forged:tls.createSecureContext({key:forged.key,cert:forged.cert})};
  const server=https.createServer({key:guest.key,cert:guest.cert,SNICallback:(_name,cb)=>cb(null,state.forged?contexts.forged:contexts.guest)},(req,res)=>{
    requests++;assert.equal(req.socket.servername,profile.hostname);assert.equal(req.headers.host,profile.hostname);
    if(onRequest)return onRequest(req,res);res.end('pong');
  });
  const wss=new WebSocketServer({noServer:true,perMessageDeflate:false,handleProtocols:set=>set.has('irc')?'irc':set.values().next().value??false});
  const seen=[];
  server.on('upgrade',(req,socket,head)=>{
    upgrades++;seen.push({url:req.url,host:req.headers.host,servername:req.socket.servername,authorization:req.headers.authorization,headers:req.headers});
    if(onUpgrade)return onUpgrade(req,socket,head);
    wss.handleUpgrade(req,socket,head,ws=>onSocket?onSocket(ws,req):ws.close());
  });
  // Decrypted bytes the guest stand-in received on any connection: a refusal must leave this at zero.
  server.on('secureConnection',socket=>socket.on('data',b=>{appBytes+=b.length;}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{for(const c of wss.clients)c.terminate();server.closeAllConnections();return new Promise(r=>server.close(r));});
  const realRequest=https.request;
  // ws and the HTTP path both go through https.request with the client's verifying agent.
  t.mock.method(https,'request',(options,callback)=>{
    assert.equal(options.host,address,'production transport must select a signed literal IP');assert.equal(options.port,443);
    return realRequest({...options,host:'127.0.0.1',port:server.address().port},callback);
  });
  const client=new NativeClient(profile,{reader,fetch,probe,now:()=>now,...clientOptions});
  return {client,state,lease,seen,wss,counts:()=>({requests,upgrades,probes,appBytes,reads,dirReads}),advance:n=>now+=n};
}
const echo=ws=>ws.on('message',(d,binary)=>ws.send(binary?Buffer.concat([Buffer.from('echo:'),d]):'echo:'+d,{binary}));
const drain=async s=>{const got=[];for await(const m of s.messages)got.push(m);return got;};

test('websocket: bidirectional text and binary frames, subprotocol, ping and close on the verified connection',async t=>{
  const server={pong:false,close:null,messages:[]};
  const r=await rig(t,{onSocket:ws=>{echo(ws);ws.on('message',d=>server.messages.push(Buffer.from(d)));ws.on('pong',d=>server.pong=d.toString());ws.ping('from-guest');
    ws.on('close',(code,reason)=>server.close={code,reason:reason.toString()});}});
  const s=await r.client.websocket({path:'/x/'+id+'/tcp/6667?mode=1',headers:AUTH,protocols:['irc','chat']});
  assert.equal(s.status,101);assert.equal(s.protocol,'irc');assert.equal(s.headers['sec-websocket-protocol'],'irc');assert.equal(s.route.address,address);assert.equal(s.proof.spkiSha256.length,64);
  assert.deepEqual(r.seen.map(x=>[x.url,x.host,x.servername,x.authorization]),[['/x/'+id+'/tcp/6667?mode=1','never-resolve.invalid','never-resolve.invalid',AUTH.Authorization]]);
  assert.equal(r.seen[0].headers['sec-websocket-protocol'],'irc,chat');assert.equal(r.seen[0].headers['sec-websocket-extensions'],undefined,'no compression offered');
  await s.send('NICK native');await s.send(new Uint8Array([0,1,2,255]));
  const it=s.messages[Symbol.asyncIterator]();
  const a=(await it.next()).value,b=(await it.next()).value;
  assert.deepEqual([a.binary,a.data.toString()],[false,'echo:NICK native']);
  assert.deepEqual([b.binary,[...b.data]],[true,[...Buffer.from('echo:'),0,1,2,255]]);
  await s.ping('from-client');            // resolves on the guest's pong
  await until(()=>server.pong==='from-guest');   // the guest's ping was answered
  const closed=await s.close(1000,'bye');
  assert.deepEqual({...closed,bytesIn:closed.bytesIn>0},{code:1000,reason:'bye',error:null,bytesIn:true,bytesOut:15});
  await until(()=>server.close);assert.deepEqual(server.close,{code:1000,reason:'bye'});
  assert.deepEqual(server.messages.map(x=>x.toString('hex')),[Buffer.from('NICK native').toString('hex'),'000102ff']);
  assert.equal((await it.next()).done,true);assert.equal(r.client.open,0);assert.equal(r.counts().probes,1);
});

test('a forged key, wrong attestation, refused hardware or changed lease refuses before any upgrade, credential or upload byte',async t=>{
  const cases={
    'forged certificate':r=>{r.state.forged=true;},
    'wrong attestation':r=>{r.state.probe='wrong app';},
    'hardware refused':r=>{r.state.probe='refuse';},
    'lease changed during attestation':r=>{r.state.onRefresh=(n,l)=>{if(n>1)l.configCid='other';};},
    'owner changed during attestation':r=>{r.state.onRefresh=(n,l)=>{if(n>1)l.owner=account(n%2?'9':'8').address;};},
    'route withdrawn':r=>{r.state.withdraw=true;},
    'lease expired':r=>{r.lease.validUntil=0;}};
  for(const [name,arrange] of Object.entries(cases))await t.test(name,async t=>{
    const r=await rig(t,{onSocket:()=>assert.fail('upgraded'),onRequest:()=>assert.fail('request reached the guest')});arrange(r);
    await assert.rejects(r.client.websocket({path:'/x/'+id+'/tcp/6667',headers:AUTH,protocols:['irc']}),/TLS key changed|fresh bound guest proof|hardware refused|changed during|verified route|current lease/);
    let pulled=0;const source=new Readable({read(){pulled++;this.push(Buffer.alloc(1024,7));}});
    await assert.rejects(r.client.stream({method:'POST',path:'/v1/upload',headers:AUTH,body:source}),/TLS key changed|fresh bound guest proof|hardware refused|changed during|verified route|current lease/);
    assert.equal(pulled,0,'the upload source is not read before verification');assert.equal(source.destroyed,true,'and it is closed');
    assert.deepEqual([r.counts().upgrades,r.counts().requests,r.counts().appBytes],[0,0,0],'the guest stand-in decrypted nothing');
    assert.equal(r.client.open,0);
  });
});

test('handshake validation: 101 status, Upgrade, Sec-WebSocket-Accept, subprotocol and extensions; no redirect, no retry',async t=>{
  const accept=key=>createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const answers={
    '/redirect':()=>'HTTP/1.1 302 Found\r\nLocation: https://must-not-follow.invalid/x\r\nContent-Length: 0\r\n\r\n',
    '/plain':()=>'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
    '/bad-accept':()=>'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: AAAA\r\n\r\n',
    '/not-websocket':k=>'HTTP/1.1 101 Switching Protocols\r\nUpgrade: h2c\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept(k)+'\r\n\r\n',
    '/wrong-protocol':k=>'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept(k)+'\r\nSec-WebSocket-Protocol: other\r\n\r\n',
    '/no-protocol':k=>'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept(k)+'\r\n\r\n',
    '/extension':k=>'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept(k)+'\r\nSec-WebSocket-Protocol: irc\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n'};
  const r=await rig(t,{onUpgrade:(req,socket)=>socket.end(answers[req.url](req.headers['sec-websocket-key']))});
  const want={'/redirect':/HTTP 302/,'/plain':/HTTP 200/,'/bad-accept':/Sec-WebSocket-Accept/,'/not-websocket':/Invalid Upgrade/,'/wrong-protocol':/invalid subprotocol/,'/no-protocol':/no subprotocol/,'/extension':/Extensions/};
  for(const [p,pattern] of Object.entries(want)){
    const e=await r.client.websocket({path:p,headers:AUTH,protocols:['irc']}).then(()=>assert.fail('opened '+p),e=>e);
    assert.match(e.message,pattern,p);if(p==='/redirect')assert.equal(e.status,302);
  }
  const n=Object.keys(want).length;
  await sleep(100);
  assert.deepEqual([r.counts().upgrades,r.counts().probes],[n,n],'each call attests once and sends one upgrade; nothing is retried or redirected');
  assert.ok(r.seen.every(x=>x.authorization===AUTH.Authorization));assert.equal(r.client.open,0);
});

test('websocket limits: frame size, send buffer, totals, idle and absolute timers, validation and concurrency',async t=>{
  const got=[];
  const r=await rig(t,{clientOptions:{maxConcurrent:2},onSocket:(ws,req)=>{
    ws.on('message',d=>got.push(req.url+':'+d.length));
    if(req.url==='/big')ws.send(Buffer.alloc(2048));
    if(req.url==='/flood')for(let i=0;i<3;i++)ws.send(Buffer.alloc(400));
    if(req.url==='/keepalive'){const iv=setInterval(()=>ws.ping(),200);ws.on('close',()=>clearInterval(iv));}
  }});
  const big=await r.client.websocket({path:'/big',maxMessageBytes:1024});
  await assert.rejects(drain(big),/Max payload/);assert.match((await big.closed).error,/Max payload/);
  const small=await r.client.websocket({path:'/small',maxMessageBytes:1024,maxBufferedBytes:1500,maxSentBytes:3000});
  await assert.rejects(small.send(Buffer.alloc(1025)),/message too large/);
  const first=small.send(Buffer.alloc(1024));
  await assert.rejects(small.send(Buffer.alloc(1024)),/send buffer full/);await first;
  await small.send(Buffer.alloc(1024));await assert.rejects(small.send(Buffer.alloc(1000)),/send limit reached/);
  await until(()=>got.filter(x=>x.startsWith('/small')).length===2);assert.deepEqual(got,['/small:1024','/small:1024'],'refused sends wrote nothing');
  small.cancel();await small.closed;
  const flood=await r.client.websocket({path:'/flood',maxBytes:1000});
  await assert.rejects(drain(flood),/received too much/);
  const idle=await r.client.websocket({path:'/idle',idleTimeoutMs:1000});
  assert.match((await idle.closed).error,/idle timeout/);
  const long=await r.client.websocket({path:'/keepalive',idleTimeoutMs:1000,maxDurationMs:1500});
  assert.match((await long.closed).error,/duration limit/);
  // concurrency: sockets and streams share the per-client bound
  const a=await r.client.websocket({path:'/a'}),b=await r.client.websocket({path:'/b'});
  await assert.rejects(r.client.websocket({path:'/c'}),/too many open/);await assert.rejects(r.client.stream({path:'/c'}),/too many open/);
  a.cancel();b.cancel();await Promise.all([a.closed,b.closed]);assert.equal(r.client.open,0);
  const probes=r.counts().probes;
  for(const bad of [{headers:{Upgrade:'websocket'}},{headers:{Connection:'Upgrade'}},{headers:{'Sec-WebSocket-Key':'x'}},{headers:{'sec-websocket-protocol':'irc'}},
    {headers:{'Sec-WebSocket-Extensions':'permessage-deflate'}},{headers:{'Sec-WebSocket-Version':'8'}},{headers:{Host:'elsewhere'}},{headers:{'Transfer-Encoding':'chunked'}},
    {headers:{'X-A':'1\r\nX-B: 2'}},{protocols:['irc','irc']},{protocols:['a b']},{protocols:'irc'},{path:'/a/../b'},{path:'/café'},{path:'/a\\b'},{path:'//x'},{path:'/a#b'},
    {maxMessageBytes:0},{maxMessageBytes:2048,maxBufferedBytes:1024},{timeoutMs:10},{unknown:1},{signal:{aborted:false}},{method:'POST'}])
    await assert.rejects(r.client.websocket({path:'/x',...bad}),/native|signal/,JSON.stringify(bad));
  assert.equal(r.counts().probes,probes,'invalid options fail before discovery or proof');
});

test('inbound backpressure: a slow reader pauses the guest connection and nothing is dropped',async t=>{
  let guest;const N=512,SIZE=64*1024;
  const r=await rig(t,{onSocket:ws=>{guest=ws;for(let i=0;i<N;i++){const m=Buffer.alloc(SIZE,i&255);m.writeUInt32BE(i);ws.send(m);}}});
  const s=await r.client.websocket({path:'/firehose',maxQueuedBytes:256*1024,maxBytes:N*SIZE});
  await sleep(500);
  assert.ok(s.queuedBytes<=256*1024+4*SIZE,'client queue stays bounded: '+s.queuedBytes);
  assert.ok(guest.bufferedAmount>8*1024*1024,'the guest is held back: '+guest.bufferedAmount);
  let i=0;
  for await(const m of s.messages){assert.equal(m.data.readUInt32BE(0),i);assert.equal(m.data.length,SIZE);if(++i===N)break;}
  assert.equal(i,N);await s.closed;assert.equal(r.client.open,0);
});

test('an open websocket closes on cancellation, authority loss, route withdrawal or a transport reset; nothing reconnects',async t=>{
  const serverClosed=[];
  const r=await rig(t,{onSocket:(ws,req)=>{ws.on('close',()=>serverClosed.push(req.url));
    const iv=setInterval(()=>ws.ping(),200);ws.on('close',()=>clearInterval(iv));
    if(req.url==='/reset')setTimeout(()=>req.socket.destroy(),300);}});
  const controller=new AbortController(),aborted=await r.client.websocket({path:'/abort',signal:controller.signal});
  controller.abort();assert.match((await aborted.closed).error,/cancelled/);
  const cancelled=await r.client.websocket({path:'/cancel'});cancelled.cancel('user stopped');assert.equal((await cancelled.closed).error,'user stopped');
  const owner=await r.client.websocket({path:'/owner',recheckMs:1000});
  r.lease.owner=account('9').address;   // ownership transferred while the socket is open
  await assert.rejects(drain(owner),/not confirmed current/);await assert.rejects(owner.send('after'),/not open/);
  r.lease.owner=account('1').address;
  const reset=await r.client.websocket({path:'/reset'});
  const done=await reset.closed;assert.equal(done.code,1006);
  await assert.rejects(reset.send('x'),/not open/);
  // last on this rig: the stored withdrawal outranks the older record from then on
  const withdrawn=await r.client.websocket({path:'/withdrawn',recheckMs:1000});
  r.state.withdraw=true;   // a newer signed route record withdraws the attested route
  assert.match((await withdrawn.closed).error,/no longer published/);
  await sleep(1200);
  // each of the 5 sockets attested once
  assert.deepEqual([r.counts().upgrades,r.counts().probes],[5,5],'no silent reconnect after any close');
  await until(()=>serverClosed.length===5);assert.deepEqual(serverClosed.sort(),['/abort','/cancel','/owner','/reset','/withdrawn']);
  assert.equal(r.client.open,0);
});

test('an open websocket closes when the lease snapshot expires',async t=>{
  const r=await rig(t,{onSocket:ws=>{const iv=setInterval(()=>ws.ping(),200);ws.on('close',()=>clearInterval(iv));}});
  const s=await r.client.websocket({path:'/expiring',recheckMs:1000});r.advance(100000);
  assert.match((await s.closed).error,/not confirmed current/);assert.equal(r.counts().upgrades,1);
});

test('reconnecting needs a fresh authorization and fresh credentials; nothing is replayed',async t=>{
  const log=[];
  const r=await rig(t,{onSocket:(ws,req)=>ws.on('message',d=>log.push(req.headers.authorization+' '+d))});
  const first=await r.client.websocket({path:'/chat',headers:{Authorization:'Bearer first'}});
  await first.send('one');await until(()=>log.length===1);await first.close();
  const before=r.counts();
  r.state.probe='refuse';
  await assert.rejects(r.client.websocket({path:'/chat',headers:{Authorization:'Bearer second'}}),/hardware refused/);
  assert.equal(r.counts().upgrades,before.upgrades,'a refused reconnect sends no upgrade');
  r.state.probe='ok';
  const third=await r.client.websocket({path:'/chat',headers:{Authorization:'Bearer third'}});
  const after=r.counts();
  assert.equal(after.probes,before.probes+2,'each connection attempt runs its own proof');
  assert.ok(after.dirReads>=before.dirReads+3&&after.reads>=before.reads+3,'and its own discovery and chain reads');
  assert.deepEqual(r.seen.map(x=>x.authorization),['Bearer first','Bearer third'],'each upgrade carries only its own call\'s credential');
  await sleep(100);assert.deepEqual(log,['Bearer first one'],'no earlier message is replayed on the new socket');
  await third.close();
});

test('streamed upload: chunks reach the guest as they are produced while an SSE response streams back',async t=>{
  let sawHeaders;
  const r=await rig(t,{onRequest:(req,res)=>{
    sawHeaders={te:req.headers['transfer-encoding'],length:req.headers['content-length'],auth:req.headers.authorization};
    res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();let total=0;
    req.on('data',d=>{total+=d.length;res.write('data: got '+total+'\n\n');});req.on('end',()=>res.end('data: done '+total+'\n\n'));
  }});
  const acks=[];
  async function* produce(){for(let i=1;i<=4;i++){yield Buffer.alloc(1000*i,i);await until(()=>acks.length>=i);}}
  const s=await r.client.stream({method:'POST',path:'/v1/chat/stream',headers:{...AUTH,'Content-Type':'application/octet-stream'},body:produce()});
  assert.equal(s.status,200);
  for await(const chunk of s.body){acks.push(...chunk.toString().split('\n\n').filter(Boolean));}
  // each 'got' arrived before the next chunk existed: the upload and the response were both streaming
  assert.deepEqual(acks,['data: got 1000','data: got 3000','data: got 6000','data: got 10000','data: done 10000']);
  assert.deepEqual(sawHeaders,{te:'chunked',length:undefined,auth:AUTH.Authorization});
  assert.deepEqual(await s.closed,{bytes:acks.join('\n\n').length+2,error:null});assert.equal(r.client.open,0);
});

test('streamed upload with a declared length, from a file and from a web stream, through request()',async t=>{
  let seen=[];
  const r=await rig(t,{onRequest:(req,res)=>{const h=createHash('sha256');let n=0;req.on('data',d=>{h.update(d);n+=d.length;});
    req.on('end',()=>{seen.push({method:req.method,length:req.headers['content-length'],te:req.headers['transfer-encoding'],n,sha:h.digest('hex')});res.writeHead(201);res.end('stored');});}});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-upload-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=dir+'/blob',bytes=Buffer.alloc(3*1024*1024);for(let i=0;i<bytes.length;i+=4)bytes.writeUInt32LE(i,i);fs.writeFileSync(file,bytes);
  const x=await r.client.request({method:'PUT',path:'/v1/files/blob',headers:AUTH,body:fs.createReadStream(file),bodyLength:bytes.length});
  assert.equal(x.status,201);assert.equal(x.body.toString(),'stored');
  assert.deepEqual(seen[0],{method:'PUT',length:String(bytes.length),te:undefined,n:bytes.length,sha:createHash('sha256').update(bytes).digest('hex')});
  const web=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('hello '));c.enqueue(new TextEncoder().encode('web'));c.close();}});
  const y=await r.client.request({method:'POST',path:'/v1/notes',headers:AUTH,body:web});
  assert.equal(y.status,201);assert.equal(seen[1].n,9);assert.equal(seen[1].te,'chunked');
  assert.equal(r.counts().probes,2);
});

test('streamed upload limits, source errors, stalls, cancellation and authority loss close the source and the transport',async t=>{
  const serverEnds=[];
  const r=await rig(t,{onRequest:(req,res)=>{req.on('data',()=>{});req.on('close',()=>serverEnds.push(req.url));
    if(req.url==='/early'){res.writeHead(200);res.write('ok');}}});
  const endless=()=>{const s={returned:false};s.it=(async function*(){try{for(;;){yield Buffer.alloc(64*1024);await sleep(1);}}finally{s.returned=true;}})();return s;};
  const tooMuch=endless();
  await assert.rejects(r.client.request({method:'POST',path:'/too-much',headers:AUTH,body:tooMuch.it,maxRequestBytes:256*1024}),/body too large/);
  await until(()=>tooMuch.returned);
  await assert.rejects(r.client.request({method:'POST',path:'/short',headers:AUTH,body:Readable.from([Buffer.alloc(5)]),bodyLength:10}),/before its declared length/);
  await assert.rejects(r.client.request({method:'POST',path:'/long',headers:AUTH,body:Readable.from([Buffer.alloc(5)]),bodyLength:3}),/body too large/);
  // fails after its first chunk was written (an immediate error would discard that chunk and send nothing)
  const failing=new Readable({read(){if(!this.sent){this.sent=true;this.push(Buffer.alloc(100));}else setTimeout(()=>this.destroy(Error('disk gone')),50);}});
  await assert.rejects(r.client.request({method:'POST',path:'/source-error',headers:AUTH,body:failing}),/native upload source failed: disk gone/);
  const stalled=new Readable({read(){if(!this.sent){this.sent=true;this.push(Buffer.alloc(100));}}});
  await assert.rejects(r.client.request({method:'POST',path:'/stall',headers:AUTH,body:stalled,idleTimeoutMs:1000}),/upload idle timeout/);
  assert.equal(stalled.destroyed,true);
  await assert.rejects(r.client.request({method:'POST',path:'/bad-chunk',headers:AUTH,body:Readable.from([{not:'bytes'}])}),/must be bytes/);
  const reached=r.counts().requests,controller=new AbortController(),cancelled=endless();
  const pending=r.client.request({method:'POST',path:'/cancel',headers:AUTH,body:cancelled.it,signal:controller.signal,maxRequestBytes:1024*1024*1024});
  await until(()=>r.counts().requests===reached+1);controller.abort();
  await assert.rejects(pending,/cancel/);await until(()=>cancelled.returned);
  // a response that started before the upload ended is cut as well when authority changes
  const owned=endless();
  const s=await r.client.stream({method:'POST',path:'/early',headers:AUTH,body:owned.it,recheckMs:1000,maxRequestBytes:1024*1024*1024});
  r.lease.owner=account('9').address;
  await assert.rejects((async()=>{for await(const _ of s.body);})(),/not confirmed current/);await until(()=>owned.returned);
  r.lease.owner=account('1').address;
  // refused input closes the source too, before any discovery
  const probes=r.counts().probes,get=Readable.from([Buffer.alloc(1)]);
  await assert.rejects(r.client.request({method:'GET',path:'/x',body:get}),/GET and HEAD/);assert.equal(get.destroyed,true);
  await assert.rejects(r.client.request({method:'PUT',path:'/x',body:'x',bodyLength:1}),/bodyLength/);
  assert.equal(r.counts().probes,probes);
  // /long and /bad-chunk failed before their first write, so not even their headers left the client
  await until(()=>serverEnds.length===6);
  assert.deepEqual(serverEnds.sort(),['/cancel','/early','/short','/source-error','/stall','/too-much']);
  assert.equal(r.counts().requests,6,'every failure is final: no request was sent twice');assert.equal(r.client.open,0);
});

test('upload backpressure: the source is read only as fast as the guest accepts it',async t=>{
  let paused,received=0;const TOTAL=48*1024*1024;
  const r=await rig(t,{onRequest:(req,res)=>{req.pause();paused=req;req.on('data',d=>received+=d.length);req.on('end',()=>res.end(String(received)));}});
  let produced=0;
  const source=new Readable({highWaterMark:64*1024,read(){if(produced>=TOTAL)return this.push(null);produced+=64*1024;this.push(Buffer.alloc(64*1024,1));}});
  const pending=r.client.request({method:'POST',path:'/slow',headers:AUTH,body:source,bodyLength:TOTAL,timeoutMs:60000});
  await until(()=>paused);await sleep(500);
  assert.ok(produced<24*1024*1024,'the client stopped pulling while the guest was not reading: '+produced);
  paused.resume();
  const x=await pending;assert.equal(x.status,200);assert.equal(x.body.toString(),String(TOTAL));assert.equal(produced,TOTAL);
});

test('command-line wrappers: a websocat-style bridge and a streamed request, credentials from the environment',async t=>{
  const r=await rig(t,{onSocket:echo,onRequest:(req,res)=>{let n=0;req.on('data',d=>n+=d.length);req.on('end',()=>{res.writeHead(200,{'content-type':'text/plain'});res.end(req.headers.authorization+' '+n);});}});
  assert.deepEqual(wsArgs(['p.json','/x/a/tcp/6667','--protocol','irc','--listen','127.0.0.1:0']),{profileFile:'p.json',path:'/x/a/tcp/6667',protocols:['irc'],listen:{host:'127.0.0.1',port:0}});
  assert.throws(()=>wsArgs(['p.json','/x','--listen','0.0.0.0:6667']),/loopback/);
  const s=await r.client.websocket({path:'/x/'+id+'/tcp/6667',headers:AUTH});
  const out=[];const stdout=new (await import('node:stream')).Writable({write(c,_e,cb){out.push(c);cb();}});
  const ended=bridge(s,Readable.from([Buffer.from('PING :a\r\n')]),stdout);
  await until(()=>Buffer.concat(out).toString().includes('echo:'));await ended;
  assert.equal(Buffer.concat(out).toString(),'echo:PING :a\r\n');assert.equal(r.client.open,0);
  const chunks=[];const sink=new (await import('node:stream')).Writable({write(c,_e,cb){chunks.push(c);cb();}});
  const status=await runRequest(r.client,{path:'/v1/upload',method:'POST',stdinBody:true,stream:true},{stdin:Readable.from([Buffer.alloc(70000)]),stdout:sink,env:{NATIVE_AUTHORIZATION:'Bearer from-env'}});
  assert.equal(status.status,200);assert.equal(Buffer.concat(chunks).toString(),'Bearer from-env 70000');
});
