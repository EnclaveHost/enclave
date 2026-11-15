// A one-hop circuit in the host's circuit runtime (network/wg-circuit-runtime.mjs, docs/design/enclave-network.md "One hop"):
// no guard grant and no outer tunnel, the tunnel's one peer is the exit's listed WireGuard endpoint, and only an app's
// circuit may be built so. The tunnel program and the ingress worker are stand-ins; no packet leaves this machine.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {WgCircuitRuntime,circuitFirewallPolicies} from '../network/wg-circuit-runtime.mjs';
import {routeProbeTransport} from '../network/privacy-agent.mjs';
import {probeGuest} from '../network/guest-probe.mjs';

const id='0x'+'ab'.repeat(32);
const prov=(n)=>({providerId:'0x'+String(n).repeat(64),address:`44.0.0.${n}`,ports:{guard:51820,exit:51821,control:8443}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(cond,what,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await cond())return;await sleep(20);}assert.fail('timed out waiting for '+what);}

// the stand-in tunnel program: every message it is sent goes to a file; outer -> outer-ready, inner -> ready
const FAKE_WG=`#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const out=v=>process.stdout.write(JSON.stringify(v)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);fs.appendFileSync(process.env.OHR_SEEN,JSON.stringify({type:v.type,paceMbps:v.paceMbps??null,endpoint:v.peer?.endpoint??null,addresses:v.peer?.addresses??null,mtu:v.peer?.mtu??null,control:v.control??null,ingress:v.ingress?Object.keys(v.ingress):null,egress:!!v.egress})+'\\n');
 if(v.type==='outer')out({type:'outer-ready',control:v.controlListen,guardSocks:v.guardSocks.listen});
 else if(v.type==='inner')out({type:'ready',...(v.egress?{egress:v.egress.listen}:{})});
});
process.stdin.on('end',()=>process.exit(0));
`;
const FAKE_WORKER=`import fs from 'node:fs';
const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
process.stdout.write(JSON.stringify({type:'ready',ingress:c.ingressPort,redirect:c.redirectPort})+'\\n');
process.stdin.resume();process.stdin.on('end',()=>process.exit(0));
`;

function world(t,{grant=(a)=>({}),paceMbps=90,renewMs=4*60000}={}){
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'ohr-'));
 const wgBinary=path.join(dir,'fake-wg.mjs'),workerModule=path.join(dir,'fake-worker.mjs'),seenFile=path.join(dir,'seen.jsonl');
 fs.writeFileSync(wgBinary,FAKE_WG,{mode:0o755});fs.writeFileSync(workerModule,FAKE_WORKER);fs.writeFileSync(seenFile,'');process.env.OHR_SEEN=seenFile;
 const asked=[],logs=[];
 const grants={
  request:async a=>{
   asked.push({url:a.url,role:a.role,provider:a.provider.address,ingress:a.ingress,egress:a.egress});
   const base=a.role==='guard'?{endpoint:`${a.provider.address}:${a.provider.ports.guard}`,clientAddress:'10.77.0.9'}:{endpoint:`${a.provider.address}:${a.provider.ports.exit}`,clientAddress:'10.78.0.9'};
   return {providerPublicKey:'k'.repeat(43)+'=',expiresAt:Date.now()+600000,...base,...grant(a,asked.length)};
  },
  revoke:async()=>{}};
 const runtime=new WgCircuitRuntime({directory:path.join(dir,'run'),wgBinary,nodeBinary:process.execPath,workerModule,serviceWorkerModule:workerModule,grants,authorize:()=>true,forward:()=>{},platform:'plain',paceMbps,renewMs,log:m=>logs.push(m)});
 t.after(async()=>{await runtime.close?.();for(const c of [...runtime.active])await c.close('test over');fs.rmSync(dir,{recursive:true,force:true});});
 const seen=()=>fs.readFileSync(seenFile,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
 return {runtime,asked,seen,logs};
}

test('one hop: one grant from the exit at its listed control port, no outer tunnel, the tunnel\'s peer is the exit\'s listed endpoint',async t=>{
 const w=world(t);
 const c=await w.runtime.start({deploymentId:id,names:['ab.app.enclave.host'],kind:'network',guard:null,exit:prov(3),ingress:true,egress:true});
 assert.deepEqual(w.asked,[{url:'http://44.0.0.3:8443',role:'exit',provider:'44.0.0.3',ingress:true,egress:true}],'no guard was asked');
 await until(()=>w.seen().length>=1,'the tunnel program\'s message');
 assert.deepEqual(w.seen(),[{type:'inner',paceMbps:90,endpoint:'44.0.0.3:51821',addresses:['10.78.0.9'],mtu:1340,control:null,ingress:['80','443'],egress:true}],
  'the only tunnel is paced like an outer one and goes to the exit\'s WireGuard port');
 assert.equal(c.oneHop,true);assert.equal(c.providers.guard,null);assert.equal(c.providers.exit.address,'44.0.0.3');
 assert.equal(c.address,'44.0.0.3');assert.equal(c.transport,'enclave-network');assert.equal(c.ingress,true);assert.equal(c.egressReady,true);
 assert.equal(c.isolation.guardAddress,null,'there is no guard to probe a route through');assert.deepEqual(c.tunnel,{guard:null,exit:'10.78.0.9'});
 assert.match(c.egress,/^127\.0\.0\.1:\d+$/);
 await c.close('done');assert.equal(w.runtime.active.size,0);
});

test('one hop: a grant that names another endpoint than the exit\'s listed one is refused before any tunnel is configured',async t=>{
 const w=world(t,{grant:()=>({endpoint:'203.0.113.7:51821'})});
 await assert.rejects(w.runtime.start({deploymentId:id,names:['ab.app.enclave.host'],kind:'network',guard:null,exit:prov(3),ingress:true,egress:true}),
  e=>/another endpoint than its listed one/.test(e.message)&&e.providerRole==='public');
 assert.deepEqual(w.seen(),[],'the tunnel program was told nothing: this host sent no packet to the other address');
 assert.equal(w.runtime.active.size,0);
});

test('one hop: renewal asks the exit alone, at the same place; an exit that hands out another address ends the circuit as the exit\'s failure',async t=>{
 let change=false;const w=world(t,{renewMs:60,grant:()=>change?{clientAddress:'10.78.0.77'}:{}});
 const c=await w.runtime.start({deploymentId:id,names:['ab.app.enclave.host'],kind:'network',guard:null,exit:prov(3),ingress:false,egress:true});
 await until(()=>w.asked.length>=3,'two renewals');
 assert.ok(w.asked.every(a=>a.url==='http://44.0.0.3:8443'&&a.role==='exit'));assert.equal(c.closed,false);
 const down=new Promise(r=>c.once('down',r));change=true;
 assert.match(await down,/the exit changed this circuit's address/);assert.equal(c.failureRole,'public');
});

test('one hop is for an app\'s circuit only: the host\'s control circuit and its services are never built without a guard',async t=>{
 const w=world(t);
 await assert.rejects(w.runtime.start({deploymentId:id,kind:'network',guard:null,exit:prov(3),egress:true,exitRole:'control',gate:()=>true}),/only an app's circuit may be one hop/);
 await assert.rejects(w.runtime.start({deploymentId:id,kind:'network',guard:undefined,exit:prov(3),ingress:true,exitRole:'service',service:{names:{'s.enclave.host':{http:8080,tls:null}},granted:['s.enclave.host'],dns:null}}),/only an app's circuit may be one hop/);
 await assert.rejects(w.runtime.start({deploymentId:id,kind:'network',guard:null,exit:null,egress:true}),/a guard and a different exit are required/);
 assert.deepEqual(w.asked,[]);assert.deepEqual(w.seen(),[]);
});

test('a guarded circuit is built as before: guard grant, paced outer tunnel, the exit asked through it, an unpaced inner tunnel',async t=>{
 const w=world(t);
 await assert.rejects(w.runtime.start({deploymentId:id,kind:'network',guard:prov(3),exit:prov(3),egress:true}),/a guard and a different exit are required/);
 const c=await w.runtime.start({deploymentId:id,names:['ab.app.enclave.host'],kind:'network',guard:prov(1),exit:prov(3),ingress:false,egress:true});
 assert.equal(w.asked.length,2);assert.deepEqual([w.asked[0].url,w.asked[0].role],['http://44.0.0.1:8443','guard']);
 assert.equal(w.asked[1].role,'exit');assert.match(w.asked[1].url,/^http:\/\/127\.0\.0\.1:\d+$/,'the exit is asked through the guard tunnel, never from this host\'s address');
 const seen=w.seen();assert.deepEqual(seen.map(m=>[m.type,m.paceMbps,m.endpoint]),[['outer',90,'44.0.0.1:51820'],['inner',null,'44.0.0.3:51821']]);
 assert.equal(seen[0].control,'44.0.0.3:8443');
 assert.equal(c.oneHop,false);assert.equal(c.providers.guard.address,'44.0.0.1');assert.match(c.isolation.guardAddress,/^127\.0\.0\.1:\d+$/);
 assert.deepEqual(c.tunnel,{guard:'10.77.0.9',exit:'10.78.0.9'});
 await c.close('done');
});

test('one hop on Windows: the tunnel program\'s sandbox allows UDP to the exit\'s WireGuard port and to nothing else',()=>{
 const [wg]=circuitFirewallPolicies({wgDir:'C:\\w',dir:'C:\\d',files:{wg:'C:\\w\\enclave-wg.exe',node:'C:\\d\\worker.exe'},udpPeer:'44.0.0.3:51821',ports:{ingress:1,redirect:2,socks:3,control:4,guardSocks:5},ingress:true,brokerPort:6});
 assert.deepEqual(wg.programs[0].udp,['44.0.0.3:51821']);assert.equal(wg.tunnel,true);
});

test('the route probe of a one-hop circuit goes from the host\'s own address with the app\'s name and a pinned key, like a direct route',async()=>{
 const guarded={kind:'network',transport:'enclave-network',address:'44.0.0.3',providers:{guard:prov(1),exit:prov(3)},isolation:{guardAddress:'127.0.0.1:4001'}};
 const oneHop={kind:'network',transport:'enclave-network',address:'44.0.0.3',providers:{guard:null,exit:prov(3)},isolation:{guardAddress:null}};
 const direct={kind:'direct',transport:'direct',address:'198.51.100.4',isolation:{}};
 assert.deepEqual(routeProbeTransport(guarded),{address:'44.0.0.3',direct:false,proxy:'127.0.0.1:4001',domainIndependent:false});
 assert.deepEqual(routeProbeTransport(guarded,true),{address:'44.0.0.3',direct:false,proxy:'127.0.0.1:4001',domainIndependent:true});
 assert.deepEqual(routeProbeTransport(oneHop),{address:'44.0.0.3',direct:true,proxy:undefined,domainIndependent:false});
 assert.deepEqual(routeProbeTransport(oneHop,true),{address:'44.0.0.3',direct:true,proxy:undefined,domainIndependent:false},'the name is sent: the exit routes by it');
 assert.deepEqual(routeProbeTransport(direct,true),{address:'198.51.100.4',direct:true,proxy:undefined,domainIndependent:false});
 // probeGuest refuses such a probe without the attested key: an unpinned handshake never leaves this host's address
 await assert.rejects(probeGuest({deploymentId:id,hostname:'ab.app.enclave.host',expected:{},...routeProbeTransport(oneHop)}),/direct route probes require an attested key and SNI/);
});
