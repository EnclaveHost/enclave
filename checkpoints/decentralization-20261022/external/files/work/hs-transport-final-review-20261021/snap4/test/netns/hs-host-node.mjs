// netns e2e helper: a HOST's own service roles behind a real 'service' circuit (WgCircuitRuntime plain mode, enclave-wg, the
// host-service ingress worker), via HostServiceTransport. Roles: loopback HTTP directory/bootstrap, and a DNS answerer
// (UDP + TCP) on 127.0.0.1:18153. Prints {names, endpoints} once the circuit is up; SIGTERM revokes and exits.
import net from 'node:net';import http from 'node:http';import dgram from 'node:dgram';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {privateKeyToAccount} from 'viem/accounts';
import {WgCircuitRuntime} from '../../network/wg-circuit-runtime.mjs';
import {WgGrants} from '../../network/wg-grants.mjs';
import {HostServiceTransport} from '../../network/host-service-transport.mjs';
const [wgBinary,gFile,xFile,operatorKey,hostId]=process.argv.slice(2);
const rec=(f,address)=>{const j=JSON.parse(fs.readFileSync(f,'utf8'));return {providerId:j.providerId,operator:j.operator,address,wgExitKey:j.keys['wg-exit'],wgGuardKey:j.keys['wg-guard'],
 ports:{exit:51820,guard:51821,control:51822},region:address,eligibleRoles:['guard','ingress','egress'],pricePerGiB6:0,qualifiedUntil:Date.now()+3600e3};};
const guard=rec(gFile,'46.0.0.2'),exit=rec(xFile,'47.0.0.2');
for(const [port,tag] of [[18188,'directory-replica'],[18189,'bootstrap-replica']])
 await new Promise(r=>http.createServer((q,s)=>{s.end(`${tag} ${q.url} host=${q.headers.host}`);}).listen(port,'127.0.0.1',r));
// a minimal authoritative answer: every A question gets 192.0.2.53
const answer=q=>{const id=q.subarray(0,2);let i=12;while(q[i])i+=q[i]+1;const question=q.subarray(12,i+5);
 return Buffer.concat([id,Buffer.from([0x84,0,0,1,0,1,0,0,0,0]),question,Buffer.from([0xc0,0x0c,0,1,0,1,0,0,0,60,0,4,192,0,2,53])]);};
const udp=dgram.createSocket('udp4');udp.on('message',(m,r)=>{try{udp.send(answer(m),r.port,r.address);}catch{}});await new Promise(r=>udp.bind(18153,'127.0.0.1',r));
await new Promise(r=>net.createServer(c=>{let b=Buffer.alloc(0);c.on('data',d=>{b=Buffer.concat([b,d]);if(b.length>=2&&b.length>=2+b.readUInt16BE(0)){const a=answer(b.subarray(2,2+b.readUInt16BE(0)));const l=Buffer.alloc(2);l.writeUInt16BE(a.length);c.end(Buffer.concat([l,a]));}});c.on('error',()=>{});}).listen(18153,'127.0.0.1',r));
const grants=new WgGrants({account:privateKeyToAccount(operatorKey),runner:hostId});
const runtime=new WgCircuitRuntime({directory:fs.mkdtempSync(path.join(os.tmpdir(),'hsrt-')),wgBinary,nodeBinary:process.execPath,
 workerModule:path.resolve('network/windows-circuit-worker.mjs'),serviceWorkerModule:path.resolve('network/host-service-ingress.mjs'),platform:'plain',renewMs:5000,resolvers:['44.0.0.1'],
 grants,authorize:()=>false,forward:s=>s.destroy(),log:m=>console.error('[runtime]',m)});
const t=new HostServiceTransport({runtime,providers:async()=>[guard,exit],grants,hostId,
 config:{zone:'svc.test',exits:[exit.providerId],ports:{'directory-replica':18188,'bootstrap-replica':18189},dns:{tcp:18153,udp:18153}},log:m=>console.error('[host]',m)});
await t.reconcile();
if(!t.circuits.size){console.error('[host] no circuit');process.exit(1);}
console.log(JSON.stringify({names:t.granted,endpoints:t.endpoints()}));
process.on('SIGTERM',async()=>{await t.close();console.error('[host] closed (revoked)');process.exit(0);});
setInterval(()=>{},1e9);
