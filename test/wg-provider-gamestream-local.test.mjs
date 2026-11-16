// The owner's local GameStream adapter (network/wg-provider/gamestream-local.mjs): its configuration, and that only a
// front presenting the pinned key is reached.
import test from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import tls from 'node:tls';import dgram from 'node:dgram';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {once} from 'node:events';import {execFileSync} from 'node:child_process';import {createHash,X509Certificate} from 'node:crypto';
import {localConfig,startLocal} from '../network/wg-provider/gamestream-local.mjs';

const good={name:'desk.app.test',connect:'127.0.0.1:44507',spkiSha256:'ab'.repeat(32),bind:'127.0.0.1'};
test('configuration: a host name, a loopback front, a 64-hex key, an address to bind',()=>{
 assert.deepEqual(localConfig(good),{name:'desk.app.test',host:'127.0.0.1',port:44507,spkiSha256:'ab'.repeat(32),bind:'127.0.0.1'});
 for(const bad of [{name:'desk'},{name:'Desk.app.test'},{connect:'10.0.0.5:443'},{connect:'127.0.0.1'},{connect:'127.0.0.1:0'},{spkiSha256:'AB'.repeat(32)},{spkiSha256:'ab'},{bind:'::'},{bind:''}])
  assert.throws(()=>localConfig({...good,...bad}),JSON.stringify(bad));
 assert.throws(()=>localConfig(null));
});

const frame=b=>{const h=Buffer.alloc(2);h.writeUInt16BE(b.length);return Buffer.concat([h,b]);};
test('a datagram reaches the front with the pinned key and comes back; another key reaches nothing',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gs-local-'));
 try{execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-keyout',path.join(dir,'k.pem'),'-out',path.join(dir,'c.pem'),'-days','1','-subj','/CN=desk.app.test'],{stdio:'ignore'});}
 catch{fs.rmSync(dir,{recursive:true,force:true});return t.skip('no openssl here');}
 const cert=fs.readFileSync(path.join(dir,'c.pem')),key=fs.readFileSync(path.join(dir,'k.pem'));fs.rmSync(dir,{recursive:true,force:true});
 const pin=createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('hex');
 // a front: answers the upgrade (no flow), then echoes each frame behind "got:"
 const seen=[],front=tls.createServer({cert,key},s=>{
  s.on('error',()=>{});let buf=Buffer.alloc(0),up=false;
  s.on('data',c=>{buf=Buffer.concat([buf,c]);
   if(!up){const end=buf.indexOf('\r\n\r\n');if(end<0)return;seen.push(buf.subarray(0,end).toString('latin1').split('\r\n')[0]);buf=buf.subarray(end+4);up=true;
    s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: enclave-port/1\r\n\r\n');}
   while(buf.length>=2){const n=buf.readUInt16BE(0);if(buf.length<2+n)break;s.write(frame(Buffer.concat([Buffer.from('got:'),buf.subarray(2,2+n)])));buf=buf.subarray(2+n);}});
 });
 front.listen(0,'127.0.0.1');await once(front,'listening');
 const ports={http:0,https:0,rtsp:0,udp:[0,0,0]},cfg={...good,connect:'127.0.0.1:'+front.address().port};
 const settle=()=>new Promise(r=>setTimeout(r,150));
 for(const [spkiSha256,expect] of [[pin,['got:hello']],['cd'.repeat(32),[]]]){
  const logs=[],g=await startLocal({...cfg,spkiSha256},{ports,log:m=>logs.push(m)}),sock=dgram.createSocket('udp4'),got=[];
  try{
   sock.bind(0,'127.0.0.1');await once(sock,'listening');sock.on('message',m=>got.push(m.toString('latin1')));
   // Moonlight asks over HTTP first: that request is what makes the client this app's (it names nothing)
   const h=net.connect(g.ports.http,'127.0.0.1');h.on('error',()=>{});await once(h,'connect');h.write('GET /serverinfo HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');await settle();await settle();h.destroy();
   sock.send(Buffer.from('hello'),g.ports.udp[1],'127.0.0.1');
   for(let i=0;i<20&&got.length<expect.length;i++)await settle();
   await settle();assert.deepEqual(got,expect);
   if(!expect.length)assert.ok(logs.some(l=>/another key than the pinned one/.test(l)),logs.join('\n'));
  }finally{sock.close();g.close();}
 }
 assert.deepEqual(seen.filter(l=>l.includes('/udp/')),['GET /.well-known/enclave-tunnel/udp/47999 HTTP/1.1']);
 assert.ok(seen.includes('GET /.well-known/enclave-tunnel/tcp/47989 HTTP/1.1'));
 front.close();
});
