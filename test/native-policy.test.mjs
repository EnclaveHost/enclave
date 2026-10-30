import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {Readable} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,X509Certificate,createHash} from 'node:crypto';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {WebSocketServer} from 'ws';
import {NativeClient} from '../network/native-client.mjs';
import {nativeHostPolicy,boundedPolicyFetch,platformBookFor} from '../network/native-host-policy.mjs';
import {createHostPolicyRuntime,resolveHostPolicyConfig} from '../network/host-policy-runtime.mjs';
import {leaseHostAdmission} from '../network/host-policy-adapters.mjs';
import {httpPolicyMirrors,MAX_POLICY_RESPONSE} from '../network/host-policy-mirrors.mjs';
import {policyTypedData} from '../network/platform-host-policy.mjs';
import {PRODUCTION_BOOK,PRODUCTION_RPCS} from '../network/platform-host-policy-config.mjs';
import {platformPolicyWorld} from './helpers/platform-policy-world.mjs';
import {signProviderRecord,signQualification,providerIdFor,CHECKS} from '../network/provider-directory.mjs';
import {defaultNetworkPolicy} from '../network/network-policy.mjs';
import {signDelegation,signRoute,recordHash} from '../network/route-record.mjs';
import {runtimeId} from '../isolation/contract/runtime.mjs';

// The native transport with the administrator's platform host policy. Policy side: the policy owner's test world
// (loopback JSON-RPC quorum answering the AddressBook/registry/ownership facts, an HTTPS mirror with its own CA,
// admin-signed and ANCHORED policies) through the shared runtime. App side: signed directory records, a real TLS
// guest stand-in with a non-WebPKI key, real HTTP and WebSocket servers. Hardware verdict and lease reads are test
// doubles, as in native-client.test.mjs.
const account=n=>privateKeyToAccount('0x'+n.repeat(64));
const operator=account('2'),checker=account('3'),owner=account('1');
const id='0x'+'ab'.repeat(32),runner='0x'+'cd'.repeat(32),otherHost='0x'+'ee'.repeat(32),address='8.8.4.4';
const runtime={name:'wasmtime',version:'test',execution:'jit',hostIsa:'x86_64',targetIsa:'x86_64',cpuFeatures:'baseline',wx:'enforced',cache:'none'};
const AUTH={Authorization:'Bearer private-test-only'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(f,ms=8000)=>{for(const end=Date.now()+ms;!f();){if(Date.now()>end)throw Error('condition not reached');await sleep(20);}};
const ban=(value,reason='malicious host')=>({kind:'registryId',value,reason});

// A mirror fetch that trusts the world's test CA (a real TLS connection; the body is a stream, read by the bound).
const caFetch=caFile=>async(url,init={})=>{
  const u=new URL(url),ca=fs.readFileSync(caFile);
  return new Promise((resolve,reject)=>{
    const req=https.request({host:u.hostname,port:u.port,path:u.pathname+u.search,method:'GET',ca,headers:init.headers||{},signal:init.signal},res=>
      resolve(new Response(Readable.toWeb(res),{status:res.statusCode,headers:Object.entries(res.headers).filter(([,v])=>typeof v==='string')})));
    req.once('error',reject);req.end();
  });
};
// A mirror that lies: mode 'forge' re-signs the served document with a key that is not the book owner;
// 'older' answers any digest with an older (validly signed) document; 'down' fails.
const lyingMirror=(inner,mirror)=>async(url,init)=>{
  if(mirror.mode==='down')throw Error('mirror unreachable');
  if(mirror.mode==='older'&&mirror.olderDigest)url=url.replace(/0x[0-9a-f]{64}\.json$/,mirror.olderDigest+'.json');
  const r=await inner(url,init);
  if(mirror.mode!=='forge'||!r.ok)return r;
  const j=JSON.parse(await r.text()),mallory=privateKeyToAccount(generatePrivateKey());
  return new Response(JSON.stringify({document:j.document,signature:await mallory.signTypedData(policyTypedData(JSON.parse(j.document)))}),{status:200});
};

// The world recomputes a block's timestamp on every call (its blocks are fabricated from the clock), which the shared
// quorum reader rightly refuses once a read spans a second boundary ("block changed during RPC read" / rollback). A
// real chain fixes a block's timestamp: this pass-through JSON-RPC proxy pins the first timestamp seen per block hash.
async function stableChain(t,rpcs){
  const seen=new Map();
  const pin=b=>{if(b&&typeof b==='object'&&b.hash){if(!seen.has(b.hash))seen.set(b.hash,b.timestamp);b.timestamp=seen.get(b.hash);}return b;};
  return Promise.all(rpcs.map(async upstream=>{
    const server=http.createServer((req,res)=>{const c=[];req.on('data',d=>c.push(d));req.on('end',async()=>{
      try{
        const body=Buffer.concat(c),r=await globalThis.fetch(upstream,{method:'POST',headers:{'content-type':'application/json'},body});
        const text=await r.text();if(!r.ok){res.writeHead(r.status);return res.end(text);}
        const j=JSON.parse(text),q=JSON.parse(body),fix=(a,qq)=>{if(/^eth_getBlockBy/.test(qq?.method))pin(a.result);return a;};
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(Array.isArray(j)?j.map((a,i)=>fix(a,q[i])):fix(j,q)));
      }catch{res.writeHead(502);res.end();}
    });});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
    return 'http://127.0.0.1:'+server.address().port;
  }));
}
async function rig(t,{onSocket=null,onRequest=null,env=null,activation=null}={}){
  const world=await platformPolicyWorld(t,{hosts:{
    [runner]:{active:true,operator:operator.address.toLowerCase(),owner:owner.address.toLowerCase(),endpoint:'https://host-a.example'},
    [otherHost]:{active:true,operator:'0x'+'99'.repeat(20),owner:'0x'+'98'.repeat(20),endpoint:'https://host-b.example'}}});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-policy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=not-a-trusted-ca','-days','1','-keyout',dir+'/key','-out',dir+'/cert'],{stdio:'ignore'});
  const cert=fs.readFileSync(dir+'/cert'),key=fs.readFileSync(dir+'/key'),spki=createHash('sha256').update(new X509Certificate(cert).publicKey.export({format:'der',type:'spki'})).digest('hex');
  let now=Date.now(),probes=0,requests=0,upgrades=0,appBytes=0;const policy=defaultNetworkPolicy(id);
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
  const publication={version:2,policy,bundle:{authorization,...signRoute(keys.privateKey,{version:2,deploymentId:id,delegationHash:recordHash(delegation),sequence:1,issuedAt:now,expiresAt:now+60000,
    routes:[{circuit:'f'.repeat(32),address,port:443,transport:'enclave-network'}]})}};
  const snapshot={version:1,providers:[{record:pr,qualifications:[qualification]}],policies:[],publications:[publication]};
  const profile={version:1,deploymentId:id,hostname:'never-resolve.invalid',stateDir:dir+'/state',chainId:8453,expected,linux:{},authorityPins:pins,checkers:[checker.address],directories:['http://192.0.2.2:8188']};
  const reader={refresh:async()=>{},get:()=>structuredClone(lease),registryEntries:async()=>[{active:true,operator:operator.address}]};
  const directoryFetch=async url=>{assert.ok(url.startsWith('http://192.0.2.2:8188/v1/network/records'));return Response.json(snapshot);};
  const probe=async options=>{probes++;assert.equal(options.address,address);return {verified:true,ready:true,deploymentId:id,appSha256:expected.appSha256,runtimeId:expected.runtimeId,spkiSha256:spki};};
  const server=https.createServer({key,cert},(req,res)=>{requests++;assert.equal(req.headers.host,profile.hostname);if(onRequest)return onRequest(req,res);res.end('pong');});
  const wss=new WebSocketServer({noServer:true,perMessageDeflate:false});
  const seen=[];
  server.on('upgrade',(req,socket,head)=>{upgrades++;seen.push(req.headers.authorization);wss.handleUpgrade(req,socket,head,ws=>onSocket?onSocket(ws,req):ws.close());});
  server.on('secureConnection',socket=>socket.on('data',b=>{appBytes+=b.length;}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{for(const c of wss.clients)c.terminate();server.closeAllConnections();return new Promise(r=>server.close(r));});
  const realRequest=https.request;
  // Only the app route is redirected (after asserting the signed literal address); the policy mirror passes through.
  t.mock.method(https,'request',(options,callback)=>{
    if(options.servername!==profile.hostname)return realRequest(options,callback);
    assert.equal(options.host,address,'production transport must select a signed literal IP');assert.equal(options.port,443);
    return realRequest({...options,host:'127.0.0.1',port:server.address().port},callback);
  });
  const mirror={mode:'pass',olderDigest:null};
  const chain=await stableChain(t,world.rpcs);
  const policyEnv={...world.env(),ENCLAVE_PLATFORM_HOST_POLICY_RPCS:chain.join(','),...(activation?{ENCLAVE_PLATFORM_HOST_POLICY_ACTIVATION:activation}:{}),...(env||{})};delete policyEnv.NODE_EXTRA_CA_CERTS;
  const policyFetch=lyingMirror(caFetch(world.ca),mirror);
  const client=new NativeClient(profile,{reader,fetch:directoryFetch,probe,now:()=>now,env:policyEnv,policyFetch});
  // the CLI's construction of the same decision (independentHostPolicy + leaseHostAdmission), for "same semantics"
  const cliDecision=async()=>{
    const r=resolveHostPolicyConfig({env:policyEnv,chainId:8453,book:null});
    const rt=createHostPolicyRuntime(r,{fetch:boundedPolicyFetch(policyFetch)});
    try{return await leaseHostAdmission(rt.gate)(structuredClone(lease));}catch(e){return {admit:false,status:'unreadable',reason:e.message};}
  };
  return {client,world,lease,mirror,cliDecision,seen,counts:()=>({probes,requests,upgrades,appBytes}),advance:n=>now+=n};
}
const endless=()=>{const s={pulled:0,returned:false};s.it=(async function*(){try{for(;;){s.pulled++;yield Buffer.alloc(16*1024);await sleep(5);}}finally{s.returned=true;}})();return s;};

test('an admin-banned host receives no proof request, credential, upgrade or upload byte',async t=>{
  const r=await rig(t,{onSocket:()=>assert.fail('upgraded'),onRequest:()=>assert.fail('request reached a banned host')});
  await r.world.publish({deny:[ban(runner,'operator served malware')]});
  const want=/platform host policy refused the route host: banned by platform policy #1 \(registryId\): operator served malware/;
  await assert.rejects(r.client.request({method:'POST',path:'/v1/upload',headers:AUTH,body:'secret'}),want);
  await assert.rejects(r.client.websocket({path:'/x/'+id+'/tcp/6667',headers:AUTH}),want);
  let pulled=0;const source=new Readable({read(){pulled++;this.push(Buffer.alloc(1024,7));}});
  await assert.rejects(r.client.stream({method:'POST',path:'/v1/upload',headers:AUTH,body:source}),want);
  assert.equal(pulled,0,'the upload source was never read');assert.equal(source.destroyed,true,'and it was closed');
  assert.deepEqual(r.counts(),{probes:0,requests:0,upgrades:0,appBytes:0},'refused before the proof: the host saw nothing');
  const e=await r.client.request({path:'/'}).catch(e=>e);assert.equal(e.code,'host_policy_refused');assert.equal(e.status,'current');
  assert.deepEqual((({admit,status})=>({admit,status}))(await r.cliDecision()),{admit:false,status:'current'},'the CLI construction decides the same');
  assert.ok(r.world.served.some(u=>u.endsWith('.json')),'the policy came from the mirror, verified against the anchor');
  assert.equal(r.client.open,0);
});

test('an allowed host works normally (credentials, streamed upload, SSE, WebSocket) while another host is banned',async t=>{
  const r=await rig(t,{onSocket:ws=>ws.on('message',d=>ws.send('echo:'+d)),onRequest:(req,res)=>{let n=0;req.on('data',d=>n+=d.length);req.on('end',()=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+req.headers.authorization+' '+n+'\n\n');});}});
  await r.world.publish({deny:[ban(otherHost)]});
  const x=await r.client.request({method:'POST',path:'/v1/upload',headers:AUTH,body:Readable.from([Buffer.alloc(70000)]),bodyLength:70000});
  assert.equal(x.status,200);assert.equal(x.body.toString(),'data: '+AUTH.Authorization+' 70000\n\n');
  const s=await r.client.websocket({path:'/chat',headers:AUTH,recheckMs:1000});
  for(let i=0;i<3;i++){await s.send('m'+i);const m=(await s.messages[Symbol.asyncIterator]().next()).value;assert.equal(m.data.toString(),'echo:m'+i);await sleep(700);}
  // ~2 s of rechecks under the policy: the socket stays open
  assert.equal((await Promise.race([s.closed,sleep(10)]))?.error,undefined);
  await s.close();assert.equal(r.client.hostPolicy.off,false);assert.equal(r.counts().probes,2);
  assert.deepEqual((({admit,status})=>({admit,status}))(await r.cliDecision()),{admit:true,status:'current'});
});

test('a newly anchored ban closes an open stream, an upload in progress and a WebSocket; nothing reconnects',async t=>{
  const closedAtServer=[];
  const r=await rig(t,{onSocket:(ws,req)=>{ws.on('close',()=>closedAtServer.push('ws'));const iv=setInterval(()=>ws.ping(),200);ws.on('close',()=>clearInterval(iv));},
    onRequest:(req,res)=>{req.on('data',()=>{});req.on('close',()=>closedAtServer.push(req.url));res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: open\n\n');}});
  await r.world.publish({deny:[ban(otherHost)]});
  const sse=await r.client.stream({path:'/events',headers:AUTH,recheckMs:1000});
  const up=endless();
  const upload=await r.client.stream({method:'POST',path:'/upload',headers:AUTH,body:up.it,recheckMs:1000,maxRequestBytes:1024*1024*1024});
  const ws=await r.client.websocket({path:'/socket',headers:AUTH,recheckMs:1000});
  const it=sse.body[Symbol.asyncIterator]();assert.equal((await it.next()).value.toString(),'data: open\n\n');
  const before=r.counts();
  await r.world.publish({deny:[ban(otherHost),ban(runner,'newly banned')]});   // the admin signs and anchors a ban
  const ended=/native authorization ended: platform host policy refused the host: banned by platform policy #2 \(registryId\): newly banned/;
  await assert.rejects(it.next(),ended);
  await assert.rejects((async()=>{for await(const _ of upload.body);})(),ended);
  assert.match((await ws.closed).error,ended);
  assert.match((await sse.closed).error,ended);
  await until(()=>up.returned);
  await until(()=>closedAtServer.length===3);assert.deepEqual(closedAtServer.sort(),['/events','/upload','ws']);
  await sleep(1500);
  const after=r.counts();assert.deepEqual([after.probes,after.requests,after.upgrades],[before.probes,before.requests,before.upgrades],'no silent reconnect');
  assert.equal(r.client.open,0);
  await assert.rejects(r.client.websocket({path:'/socket',headers:AUTH}),/refused the route host: banned/);
  // the admin lifts the ban with a newer anchored policy: a NEW call (fresh decision, fresh proof) works again
  await r.world.publish({deny:[ban(otherHost)]});
  const again=await r.client.websocket({path:'/socket',headers:{Authorization:'Bearer later'}});assert.equal(again.status,101);await again.close();
  assert.equal(r.seen.at(-1),'Bearer later');
});

test('forged, older, torn, unreachable and unactivated policy follow the shared semantics (same decision as the CLI)',async t=>{
  const cases={
    'forged signature on the anchored document':{arrange:async r=>{await r.world.publish({deny:[ban(otherHost)]});r.mirror.mode='forge';},status:'behind'},
    'older validly signed policy for a newer anchor':{arrange:async r=>{r.mirror.olderDigest=await r.world.publish({deny:[]});await r.world.publish({deny:[ban(runner)]});r.mirror.mode='older';},status:'behind'},
    'torn anchor':{arrange:async r=>{await r.world.publish({deny:[]});r.world.state.lo='0x'+'00'.repeat(20);},status:'anchor'},
    'policy RPC quorum unreachable':{arrange:async r=>{await r.world.publish({deny:[]});r.world.setDown(true);},status:'unreadable'},
    'mirror unreachable for the anchored policy':{arrange:async r=>{await r.world.publish({deny:[]});r.mirror.mode='down';},status:'behind'},
    'unanchored under activation "required"':{activation:'required',arrange:async()=>{},status:'unanchored'}};
  for(const [name,c] of Object.entries(cases))await t.test(name,async t=>{
    const r=await rig(t,{activation:c.activation,onSocket:()=>assert.fail('upgraded'),onRequest:()=>assert.fail('request reached the host')});
    await c.arrange(r);
    const e=await r.client.websocket({path:'/x',headers:AUTH}).then(()=>assert.fail('opened'),e=>e);
    assert.equal(e.code,'host_policy_refused',e.message);assert.equal(e.status,c.status,e.message);
    const cli=await r.cliDecision();assert.equal(cli.admit,false);assert.equal(cli.status,c.status,'the CLI construction decides the same: '+cli.reason);
    assert.deepEqual(r.counts(),{probes:0,requests:0,upgrades:0,appBytes:0});
  });
  // the admin has anchored nothing and activation is the production default "anchor": not activated, admitted as today
  await t.test('unanchored under activation "anchor" (not activated)',async t=>{
    const r=await rig(t,{onSocket:ws=>ws.close()});
    const s=await r.client.websocket({path:'/x',headers:AUTH});assert.equal(s.status,101);await s.closed;
    assert.deepEqual((({admit,status})=>({admit,status}))(await r.cliDecision()),{admit:true,status:'not-activated'});
  });
  // the operator's existing explicit configuration "off": the shared resolution turns the policy off (stated, not a fallback)
  await t.test('explicit ENCLAVE_PLATFORM_HOST_POLICY=off',async t=>{
    const r=await rig(t,{env:{ENCLAVE_PLATFORM_HOST_POLICY:'off'},onSocket:ws=>ws.close()});
    assert.equal(r.client.hostPolicy.off,true);assert.match(r.client.hostPolicy.reason,/explicitly disabled/);
    r.world.setDown(true);   // nothing is read from the policy chain when it is off
    const s=await r.client.websocket({path:'/x',headers:AUTH});assert.equal(s.status,101);await s.closed;
  });
});

test('a profile pinned to the Enclave platform network is enforced by default with the production authority; profiles cannot opt out',()=>{
  const pins=JSON.parse(fs.readFileSync(new URL('../contracts/deployments/contract-pins-base.json',import.meta.url))).contracts;
  const base={version:1,chainId:8453,stateDir:'/tmp/never-written',authorityPins:{deployments:pins.deployments,registry:'0x'+'06'.repeat(20)}};
  for(const profile of [base,{...base,authorityPins:{deployments:'0x'+'05'.repeat(20),registry:pins.registry}},
    {...base,hostPolicy:{book:'0x'+'11'.repeat(20)},platformHostPolicy:'off',policy:'off'}]){
    assert.equal(platformBookFor(profile),PRODUCTION_BOOK);
    const hp=nativeHostPolicy(profile,{env:{}});
    assert.equal(hp.off,false);assert.equal(hp.runtime.config.book,PRODUCTION_BOOK);assert.deepEqual(hp.runtime.config.rpcs,[...PRODUCTION_RPCS]);assert.equal(hp.activation,'anchor');
  }
  const testNet=nativeHostPolicy({...base,authorityPins:{deployments:'0x'+'05'.repeat(20),registry:'0x'+'06'.repeat(20)}},{env:{}});
  assert.equal(testNet.off,true);assert.match(testNet.reason,/not the production chain\/book/);
  // the existing operator configuration values keep their shared meaning
  assert.equal(nativeHostPolicy(base,{env:{ENCLAVE_PLATFORM_HOST_POLICY:'production'}}).runtime.config.book,PRODUCTION_BOOK);
  assert.throws(()=>nativeHostPolicy(base,{env:{ENCLAVE_PLATFORM_HOST_POLICY:'{not json'}}),/ENCLAVE_PLATFORM_HOST_POLICY/);
  assert.throws(()=>nativeHostPolicy(base,{env:{ENCLAVE_PLATFORM_HOST_POLICY_ACTIVATION:'never'}}),/ACTIVATION must be anchor or required/);
});

test('mirror bodies are bounded before buffering, through the shared mirror transport',async t=>{
  let written=0,closedEarly=false;
  const server=http.createServer((req,res)=>{
    if(req.url.includes('declared')){res.writeHead(200,{'content-length':String(8*1024*1024)});res.write('{');return;}
    res.writeHead(200,{'content-type':'application/json'});   // chunked, no declared length
    const chunk=Buffer.alloc(64*1024,0x20);const pump=()=>{while(written<8*1024*1024&&res.write(chunk))written+=chunk.length;if(written<8*1024*1024)res.once('drain',()=>{written+=chunk.length;pump();});else res.end();};
    res.on('close',()=>{if(written<8*1024*1024)closedEarly=true;});pump();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const local=(url,init)=>globalThis.fetch('http://127.0.0.1:'+server.address().port+new URL(url).pathname,init);
  const [huge]=httpPolicyMirrors(['https://mirror.test/huge'],{fetch:boundedPolicyFetch(local)});
  assert.deepEqual(await huge('0x'+'ab'.repeat(32)),[],'an oversize body yields no candidate');
  await until(()=>closedEarly);assert.ok(written<4*1024*1024,'the reader stopped early: '+written);
  const [declared]=httpPolicyMirrors(['https://mirror.test/declared'],{fetch:boundedPolicyFetch(local)});
  assert.deepEqual(await declared('0x'+'ab'.repeat(32)),[]);
  // a body exactly at the bound is still accepted (JSON padded with spaces)
  const exact=async()=>new Response(JSON.stringify({document:'{}',signature:'0x'}).padEnd(MAX_POLICY_RESPONSE,' '),{status:200});
  assert.equal((await boundedPolicyFetch(exact)('https://m/x.json')).status,200);
  const over=async()=>new Response('x'.repeat(MAX_POLICY_RESPONSE+1),{status:200});
  assert.equal((await boundedPolicyFetch(over)('https://m/x.json')).status,413);
});
