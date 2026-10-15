// Host egress (policy mode 'host', network/host-egress.mjs): the policy shape, the destination judgement (the same set
// enclave-wg's SOCKS refuses), a real SOCKS5 exchange through the entry, and the manager building it with Enclave-network
// ingress, refusing it on a host that does not offer it, and falling back when the owner allowed that.
import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import {EventEmitter} from 'node:events';
import {validateNetworkPolicy,networkUse,defaultNetworkPolicy} from '../network/network-policy-core.mjs';
import {HostEgress,judgeHostDestination} from '../network/host-egress.mjs';
import {EnclaveNetworkManager} from '../network/wg-manager.mjs';
import {createNetworkHost,hostEgressOffer} from '../network/enclave-network-host.mjs';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';

const id='0x'+'cd'.repeat(32);
const base={version:5,deploymentId:id,nonce:1,issuedAt:1,fallback:'none'};
const net2={routes:2,guard:true,maxPricePerGiB6:0,budget6:0};

test('host mode: ingress none or on the Enclave network, optional Enclave-network fallback',()=>{
 assert.ok(validateNetworkPolicy({...base,mode:'host',host:{ingress:'none'}}));
 assert.ok(validateNetworkPolicy({...base,mode:'host',host:{ingress:'enclave-network'},enclaveNetwork:net2}));
 assert.ok(validateNetworkPolicy({...base,mode:'host',fallback:'enclave-network',host:{ingress:'none'},enclaveNetwork:net2}));
 assert.throws(()=>validateNetworkPolicy({...base,mode:'host'}),/host settings/);
 assert.throws(()=>validateNetworkPolicy({...base,mode:'host',host:{ingress:'direct'}}),/invalid host settings/);
 assert.throws(()=>validateNetworkPolicy({...base,mode:'host',host:{ingress:'none',extra:1}}),/invalid host settings/);
 assert.throws(()=>validateNetworkPolicy({...base,mode:'host',host:{ingress:'enclave-network'}}),/Enclave network settings required/);
 assert.throws(()=>validateNetworkPolicy({...base,mode:'host',host:{ingress:'none'},enclaveNetwork:net2}),/unused Enclave network settings/);
 assert.throws(()=>validateNetworkPolicy({...defaultNetworkPolicy(id),host:{ingress:'none'}}),/host settings belong to host only/);
 const u=networkUse({...base,mode:'host',fallback:'enclave-network',host:{ingress:'enclave-network'},enclaveNetwork:net2});
 assert.deepEqual([u.egress,u.ingress,u.fallback],['host','enclave-network','enclave-network']);
 assert.equal(networkUse({...base,mode:'host',host:{ingress:'none'}}).ingress,'none');
});

test('destinations: the same refusals as enclave-wg (private, reserved, metadata, SMTP, own address)',()=>{
 for(const a of ['10.1.2.3','192.168.1.1','172.20.0.1','127.0.0.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','255.255.255.255',
  '198.18.0.1','192.0.2.1','::1','fe80::1','fd00::1','::ffff:192.168.1.1','2001:db8::1'])assert.equal(judgeHostDestination(a,443),'refused',a);
 assert.equal(judgeHostDestination('1.1.1.1',443),null);
 assert.equal(judgeHostDestination('::ffff:1.1.1.1',443),null,'IPv4-mapped is judged as its IPv4');
 assert.equal(judgeHostDestination('1.1.1.1',25),'refused','no SMTP');
 assert.equal(judgeHostDestination('1.1.1.1',0),'refused');
 assert.equal(judgeHostDestination('203.0.114.7',9984,{own:['203.0.114.7']}),'refused','never the host itself');
 assert.equal(judgeHostDestination('2606:4700::1111',443,{noIPv6:true}),'refused');
 assert.equal(judgeHostDestination('2606:4700::1111',443),null);
});

// SOCKS5 CONNECT through the entry; -> {code, socket}
function socks(port,{host,ip,dport}){
 return new Promise((resolve,reject)=>{
  const s=net.connect({host:'127.0.0.1',port});let buf=Buffer.alloc(0),stage=0;
  s.on('error',reject);s.on('close',()=>stage<2&&resolve({code:-1,socket:s}));
  s.on('data',d=>{buf=Buffer.concat([buf,d]);
   if(stage===0&&buf.length>=2){assert.deepEqual([...buf.subarray(0,2)],[5,0]);buf=buf.subarray(2);stage=1;
    const p=Buffer.alloc(2);p.writeUInt16BE(dport);
    s.write(Buffer.concat([Buffer.from([5,1,0]),ip?Buffer.from([1,...ip.split('.').map(Number)]):Buffer.concat([Buffer.from([3,host.length]),Buffer.from(host)]),p]));}
   if(stage===1&&buf.length>=10){stage=2;const code=buf[1];buf=buf.subarray(10);s.removeAllListeners('data');resolve({code,socket:s,rest:buf});}
  });
  s.write(Buffer.from([5,1,0]));
 });
}

test('the SOCKS entry: connects judged public addresses, refuses the rest, resolves names publicly, honours admission',async()=>{
 const echo=net.createServer(c=>c.pipe(c));await new Promise(r=>echo.listen(0,'127.0.0.1',r));
 const dialed=[];let allowed=true;
 // the "internet": every allowed public destination lands on the local echo server
 const eg=new HostEgress({authorize:()=>allowed,own:['203.0.114.7'],lookup:async n=>n==='sia.example'?['192.168.1.5','93.184.216.34']:[],
  connect:({host,port,timeout})=>{dialed.push(`${host}:${port}`);return net.connect({host:'127.0.0.1',port:echo.address().port,timeout});}});
 const c=await eg.start({deploymentId:id});const port=+c.egress.split(':')[1];
 const ok=await socks(port,{ip:'93.184.216.34',dport:9984});assert.equal(ok.code,0);
 ok.socket.write('ping');const back=await new Promise(r=>ok.socket.once('data',r));assert.equal(String(back),'ping');ok.socket.destroy();
 for(const [d,why] of [[{ip:'192.168.1.1',dport:80},'LAN'],[{ip:'169.254.169.254',dport:80},'metadata'],[{ip:'93.184.216.34',dport:25},'SMTP'],[{ip:'203.0.114.7',dport:443},'own address']]){
  const r=await socks(port,d);assert.equal(r.code,2,why);r.socket.destroy();
 }
 const named=await socks(port,{host:'sia.example',dport:443});assert.equal(named.code,0);named.socket.destroy();
 assert.equal(dialed.at(-1),'93.184.216.34:443','the private answer was skipped, the public one dialed');
 const nx=await socks(port,{host:'nowhere.example',dport:443});assert.equal(nx.code,4);nx.socket.destroy();
 assert.ok(!dialed.some(d=>/^(192\.168|169\.254|203\.0\.114)/.test(d)||d.endsWith(':25')),'refused destinations are never dialed');
 allowed=false;const shut=await socks(port,{ip:'93.184.216.34',dport:443}).catch(()=>({code:-1}));assert.equal(shut.code,-1,'no lease: the entry refuses');
 await c.close('test');await eg.close();echo.close();
});

function rig({offer=true,hostFails=false}={}){
 const started=[],published=[];
 const admission={allows:()=>true,leases:new Map([[id,{validUntil:Date.now()+600000}]]),proofs:new Map([[id,{validUntil:Date.now()+600000}]])};
 const prov=n=>({providerId:String(n).repeat(32).slice(0,32),address:`44.0.0.${n}`,wgExitKey:'x'+n,wgGuardKey:'g'+n,ports:{exit:51820,guard:51821,control:51822},
  region:'r'+n,kind:'enclave',pricePerGiB6:0,eligibleRoles:['guard','ingress','egress'],qualifiedUntil:Date.now()+600000});
 const runtime={start:async a=>{const c=new EventEmitter();Object.assign(c,{...a,id:String(started.length).padStart(32,'0'),closed:false,providers:{guard:a.guard,exit:a.exit},
  address:a.exit.address,egressReady:!!a.egress,egress:a.egress?'127.0.0.1:9':null,admit(){},async close(r){this.closed=true;this.emit('down',r);}});started.push(c);return c;}};
 const offered={on:true};
 const hostEgress=offer?{allows:x=>offered.on&&x===id,start:async({deploymentId})=>{if(hostFails)throw new Error('no route out');const c=new EventEmitter();
  Object.assign(c,{id:'h'.repeat(32),deploymentId,kind:'host',closed:false,ingress:false,egressReady:true,egress:'127.0.0.1:7',providers:{host:{}},admit(){},async close(r){this.closed=true;this.emit('down',r);}});started.push(c);return c;}}:null;
 const m=new EnclaveNetworkManager({runtime,admission,providers:async()=>[1,2,3,4].map(prov),probe:async()=>{},probeEgress:async()=>{},hostEgress,publish:async(i,r)=>{published.push(r);}});
 return {m,started,published,offered};
}
const app=policy=>({deploymentId:id,names:['cdcdcdcd.app.enclave.host'],policy,isPublic:true});

test('manager: host egress plus ingress-only network circuits; the website stays on the Enclave network',async()=>{
 const r=rig();await r.m.configure([app({...base,mode:'host',host:{ingress:'enclave-network'},enclaveNetwork:net2})]);await r.m.reconcile();
 const a=r.m.apps.get(id),host=a.circuits.filter(c=>c.kind==='host'),netc=a.circuits.filter(c=>c.kind==='network');
 assert.equal(host.length,1);assert.equal(netc.length,2);assert.ok(netc.every(c=>c.ingress&&!c.egressReady),'network circuits carry ingress only');
 const s=r.m.status()[0];assert.equal(s.egress,'host');assert.ok(s.modes.includes('host'));assert.equal(s.ready,true);
 assert.ok(r.published.at(-1).length===2&&r.published.at(-1).every(x=>x.transport==='enclave-network'),'only the network circuits are published');
});

test('manager: host egress with no ingress builds no network circuit at all',async()=>{
 const r=rig();await r.m.configure([app({...base,mode:'host',host:{ingress:'none'}})]);await r.m.reconcile();
 const a=r.m.apps.get(id);assert.deepEqual(a.circuits.map(c=>c.kind),['host']);assert.equal(r.m.status()[0].ready,true);
});

test('manager: a host that does not offer its connection refuses the mode (and the Network tab is not offered it)',async()=>{
 const r=rig({offer:false});await r.m.configure([app({...base,mode:'host',host:{ingress:'none'}})]);await r.m.reconcile();
 const s=r.m.status()[0];assert.match(s.error,/does not offer its own connection/);assert.equal(s.ready,false);assert.ok(!s.modes.includes('host'));
});

test('manager: host egress down with the owner\'s fallback: one egress-only network circuit carries it',async()=>{
 const r=rig({hostFails:true});await r.m.configure([app({...base,mode:'host',fallback:'enclave-network',host:{ingress:'enclave-network'},enclaveNetwork:net2})]);await r.m.reconcile();
 const a=r.m.apps.get(id),s=r.m.status()[0];
 assert.equal(s.fallbackActive,true);assert.ok(a.circuits.some(c=>c.kind==='network'&&c.fallback&&c.egressReady&&!c.ingress));
 assert.equal(a.circuits.filter(c=>c.kind==='network'&&!c.fallback).length,2,'the website circuits are untouched');
});

test('manager: the operator withdraws the offer (config reload): the host circuit goes, the owner\'s fallback takes over',async()=>{
 const r=rig();await r.m.configure([app({...base,mode:'host',fallback:'enclave-network',host:{ingress:'none'},enclaveNetwork:net2})]);await r.m.reconcile();
 const a=r.m.apps.get(id),host=a.circuits.find(c=>c.kind==='host');assert.ok(host&&!host.closed);
 r.offered.on=false;await r.m.reconcile();
 assert.ok(host.closed,'the host circuit is closed');assert.ok(!a.circuits.some(c=>c.kind==='host'));
 assert.ok(a.circuits.some(c=>c.kind==='network'&&c.fallback&&c.egressReady),'the fallback carries the egress');
 assert.ok(!r.m.status()[0].modes.includes('host'),'the Network tab no longer offers host');
 r.offered.on=true;await r.m.reconcile();
 assert.ok(a.circuits.some(c=>c.kind==='host'&&!c.closed),'offered again: the host circuit comes back');
});

test('network host: hostEgress changes apply in place; a malformed block is refused and the offer stands',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'host-egress-offer-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const other='0x'+'ab'.repeat(32);
 const host=await createNetworkHost({config:{relay:'http://127.0.0.1:9',checkers:['0x'+'22'.repeat(20)],apps:'all',wgBinary:'/bin/true',nodeBinary:process.execPath,workerModule:'/bin/true'},
  directory:dir,authorize:()=>true,fetch:async()=>new Response('{}',{status:404})});
 assert.equal(host.hostEgress.allows(id),false,'no hostEgress block: nothing offered');
 await assert.rejects(host.hostEgress.start({deploymentId:id}),/does not offer/);
 assert.equal(host.hostEgress.update({apps:[id],own:['203.0.113.9']}),true);
 assert.equal(host.hostEgress.allows(id),true);assert.equal(host.hostEgress.allows(other),false);
 assert.equal(host.hostEgress.update({apps:[id],own:['203.0.113.9']}),false,'the same offer is no change');
 assert.throws(()=>host.hostEgress.update({apps:['nope']}),/hostEgress.apps/);
 assert.equal(host.hostEgress.allows(id),true,'a refused block leaves the offer in force');
 const c=await host.hostEgress.start({deploymentId:id});assert.equal(c.kind,'host');
 assert.equal(host.hostEgress.update({apps:'all'}),true);assert.equal(host.hostEgress.allows(other),true);
 assert.deepEqual(host.hostEgress.offered,{apps:'all',own:[]});
 assert.equal(host.hostEgress.update(undefined),true);assert.equal(host.hostEgress.allows(id),false,'removed: nothing offered');
 await c.close('test');await host.hostEgress.close();
 assert.equal(hostEgressOffer(null),null);assert.throws(()=>hostEgressOffer({apps:'all',own:['nope']}),/hostEgress.own/);
});
