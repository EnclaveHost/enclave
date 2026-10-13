#!/usr/bin/env node
// Soak the Enclave network's public ingress on a real provider (docs/design/enclave-network-status.md): this checker
// takes a probe peer (as wg-qualify does), serves TLS behind it - a WebSocket echo and a large deterministic stream -
// and then reaches it the way visitors reach apps: public IP:443, SNI routed, through WireGuard, TLS ending here.
//   node scripts/network/wg-soak.mjs --key-file checker.key --wg enclave-wg --relay https://api.enclave.host \
//        --provider <address> [--ws-messages 2000] [--stream-mib 200] [--parallel 8]
import fs from 'node:fs/promises';import tls from 'node:tls';import net from 'node:net';import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';import {createInterface} from 'node:readline';import os from 'node:os';import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';import {recoverMessageAddress} from 'viem';
import {peerRequestMessage,grantMessage} from '../../network/wg-provider/provider.mjs';
import {wireGuardKeypair} from '../../network/wg-grants.mjs';
import {verifyProviderRecord} from '../../network/provider-directory.mjs';
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:d;};
const account=privateKeyToAccount((await fs.readFile(arg('key-file'),'utf8')).trim());
const log=m=>console.log(new Date().toISOString(),m);
const d=await (await fetch(arg('relay','https://api.enclave.host')+'/v1/network/providers')).json();
let rec;for(const e of d.providers){try{const r=await verifyProviderRecord(e.record,{hostOperator:async()=>null});if(r.address===arg('provider'))rec=r;}catch{}}
if(!rec)throw new Error('provider not in the directory');
// the probe peer: ingress for one random name
const keys=wireGuardKeypair(),zero='0x'+'0'.repeat(64),now=Date.now();
const request={version:1,providerId:rec.providerId,role:'probe',deploymentId:zero,runner:zero,wgPublicKey:keys.publicKey,policy:null,ingress:true,egress:true,issuedAt:now,nonce:randomBytes(16).toString('hex'),expiresAt:now+5*60000};
const res=await fetch(`http://${rec.address}:${rec.ports.control}/v1/peer`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request,signature:await account.signMessage({message:peerRequestMessage(request)})})});
const b=await res.json();if(!res.ok)throw new Error(b.error);
const g=b.grant;if((await recoverMessageAddress({message:grantMessage(g),signature:b.signature})).toLowerCase()!==rec.operator)throw new Error('grant not signed by the provider');
const name=g.names[0];
// a TLS server on loopback: the "app" (its key exists only here)
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'soak-'));
execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN='+name,'-keyout',dir+'/k.pem','-out',dir+'/c.pem','-days','1'],{stdio:'ignore'});
const block=Buffer.alloc(1<<20);for(let i=0;i<block.length;i++)block[i]=(i*131+7)&255;
const server=tls.createServer({key:await fs.readFile(dir+'/k.pem'),cert:await fs.readFile(dir+'/c.pem')},s=>{
 let head=Buffer.alloc(0);
 const onData=chunk=>{head=Buffer.concat([head,chunk]);const end=head.indexOf('\r\n\r\n');if(end<0)return;s.off('data',onData);
  const req=head.subarray(0,end).toString(),rest=head.subarray(end+4),pathname=req.split(' ')[1]||'/';
  if(/^upgrade: *websocket/im.test(req)){const k=/sec-websocket-key: *(.+)/i.exec(req)[1].trim();
   s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+createHash('sha1').update(k+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')+'\r\n\r\n');
   let buf=rest;const pump=c=>{if(c)buf=Buffer.concat([buf,c]);for(;;){if(buf.length<2)return;let len=buf[1]&127,o=2;if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);o=4;}else if(len===127){if(buf.length<10)return;len=Number(buf.readBigUInt64BE(2));o=10;}
    if(buf.length<o+4+len)return;const mask=buf.subarray(o,o+4),p=Buffer.from(buf.subarray(o+4,o+4+len));for(let i=0;i<p.length;i++)p[i]^=mask[i&3];const op=buf[0]&15;buf=buf.subarray(o+4+len);
    if(op===8){s.end();return;}const h=p.length<126?Buffer.from([0x80|op,p.length]):p.length<65536?Buffer.from([0x80|op,126,p.length>>8,p.length&255]):(()=>{const x=Buffer.alloc(10);x[0]=0x80|op;x[1]=127;x.writeBigUInt64BE(BigInt(p.length),2);return x;})();s.write(Buffer.concat([h,p]));}};
   s.on('data',pump);pump();return;}
  const mib=Number(/^\/stream\/(\d+)$/.exec(pathname)?.[1]||0);
  s.write(`HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: ${mib<<20}\r\nconnection: close\r\n\r\n`);
  let left=mib;const more=()=>{while(left>0){left--;if(!s.write(block))return s.once('drain',more);}s.end();};more();
 };s.on('data',onData);s.on('error',()=>{});
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
// enclave-wg: the probe peer's tunnel, ingress 443 -> the server above
const wg=spawn(arg('wg'),[],{stdio:['pipe','pipe','inherit']});const lines=createInterface({input:wg.stdout});
const ready=new Promise((ok,no)=>lines.on('line',l=>{const v=JSON.parse(l);if(v.type==='ready')ok(v);if(v.type==='down')no(new Error(v.error));}));
wg.stdin.write(JSON.stringify({type:'inner',peer:{privateKey:keys.privateKey,publicKey:g.providerPublicKey,endpoint:g.endpoint,addresses:[g.clientAddress],mtu:1340,keepalive:5},ingress:{'443':'127.0.0.1:'+server.address().port}})+'\n');
await ready;log(`probe peer up on ${rec.address} (${rec.region}) as ${name}`);
const connect=()=>new Promise((ok,no)=>{const s=tls.connect({host:rec.address,port:443,servername:name,rejectUnauthorized:false},()=>ok(s));s.once('error',no);});
// 1. WebSockets: one connection, many messages of varied sizes, every echo checked
{const s=await connect();s.write(`GET /ws HTTP/1.1\r\nHost: ${name}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
 let buf=Buffer.alloc(0),upgraded=false,got=0,bad=0;const n=Number(arg('ws-messages',2000)),sent=[],t0=Date.now();
 const frame=p=>{const mask=randomBytes(4),m=Buffer.from(p);for(let i=0;i<m.length;i++)m[i]^=mask[i&3];const h=p.length<126?Buffer.from([0x82,0x80|p.length]):Buffer.from([0x82,0x80|126,p.length>>8,p.length&255]);return Buffer.concat([h,mask,m]);};
 await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(new Error(`WebSocket: ${got}/${n} echoes after 120 s`)),120000);
  s.on('data',c=>{buf=Buffer.concat([buf,c]);if(!upgraded){const e=buf.indexOf('\r\n\r\n');if(e<0)return;if(!/^HTTP\/1.1 101/.test(buf.toString()))return fail(new Error('no WebSocket upgrade'));upgraded=true;buf=buf.subarray(e+4);
    for(let i=0;i<n;i++){const p=randomBytes(1+Math.floor(Math.random()*60000));sent.push(createHash('sha256').update(p).digest('hex'));s.write(frame(p));}}
   for(;;){if(buf.length<2)return;let len=buf[1]&127,o=2;if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);o=4;}if(buf.length<o+len)return;
    if(createHash('sha256').update(buf.subarray(o,o+len)).digest('hex')!==sent[got])bad++;got++;buf=buf.subarray(o+len);if(got===n){clearTimeout(timer);done();}}});});
 log(`WebSocket: ${got} messages echoed (${bad} altered) in ${((Date.now()-t0)/1000).toFixed(1)} s`);if(bad)process.exitCode=1;s.destroy();}
// 2. sustained streams: several in parallel, every byte checked
{const mib=Number(arg('stream-mib',200)),par=Number(arg('parallel',8)),each=Math.ceil(mib/par),want=createHash('sha256');for(let i=0;i<each;i++)want.update(block);const wantHex=want.digest('hex'),t0=Date.now();
 const one=async()=>{const s=await connect();s.write(`GET /stream/${each} HTTP/1.1\r\nHost: ${name}\r\nConnection: close\r\n\r\n`);let head=true,acc=Buffer.alloc(0);const h=createHash('sha256');let n=0;
  await new Promise((ok,no)=>{s.on('data',c=>{if(head){acc=Buffer.concat([acc,c]);const e=acc.indexOf('\r\n\r\n');if(e<0)return;head=false;c=acc.subarray(e+4);}n+=c.length;h.update(c);});s.on('end',ok);s.on('error',no);});
  return {n,ok:h.digest('hex')===wantHex};};
 const r=await Promise.all(Array.from({length:par},one));const total=r.reduce((a,x)=>a+x.n,0),secs=(Date.now()-t0)/1000;
 log(`streams: ${par} x ${each} MiB, ${(total/2**20).toFixed(0)} MiB in ${secs.toFixed(1)} s = ${(total*8/secs/1e6).toFixed(1)} Mbit/s; intact: ${r.filter(x=>x.ok).length}/${par}`);
 if(r.some(x=>!x.ok))process.exitCode=1;}
wg.kill();server.close();await fs.rm(dir,{recursive:true,force:true});
