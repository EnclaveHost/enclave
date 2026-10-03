import test from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import https from 'node:https';import tls from 'node:tls';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {execFileSync} from 'node:child_process';import {once} from 'node:events';
import {DirectRuntime} from '../network/direct-runtime.mjs';
import {createDirectEgress} from '../network/direct-egress.mjs';
import {connectSOCKS} from '../network/socks-connect.mjs';
const id='0x'+'ab'.repeat(32);
test('direct ingress preserves guest TLS, meters both directions and revokes existing sockets',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'direct-tls-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=direct.test',
    '-addext','subjectAltName=DNS:direct.test','-days','1','-keyout',path.join(dir,'key'),'-out',path.join(dir,'cert')],{stdio:'ignore'});
  const cert=await fs.readFile(path.join(dir,'cert')),key=await fs.readFile(path.join(dir,'key'));
  const guest=https.createServer({key,cert},(_req,res)=>res.end('guest response'));
  await new Promise(r=>guest.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>guest.close(r)));
  let allowed=true;const bytes={in:0,out:0};
  const runtime=new DirectRuntime({address:'8.1.2.3',bindHost:'127.0.0.1',httpsPort:0,httpPort:0,
    authorize:()=>allowed,terms:async()=>({expiresAt:Date.now()+60000,pricePerGiB6:'0',selfHosted:true}),
    meter:async()=>({consume:async(d,n)=>{bytes[d]+=n;}}),forward:(socket,deployment)=>{
      assert.equal(deployment,id);const upstream=net.connect(guest.address().port,'127.0.0.1');
      socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
      socket.once('close',()=>upstream.destroy());upstream.once('close',()=>socket.destroy());socket.pipe(upstream).pipe(socket);
    }});t.after(()=>runtime.close());
  const app=await runtime.start({deploymentId:id,names:['direct.test'],policy:{}});app.admit(Date.now()+60000);
  const result=await new Promise((resolve,reject)=>{
    https.get({host:'127.0.0.1',port:runtime.httpsPort,servername:'direct.test',ca:cert,agent:false},res=>{
      let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve(body));res.on('error',reject);
    }).on('error',reject);
  });assert.equal(result,'guest response');assert.ok(bytes.in>0&&bytes.out>0);
  const socket=tls.connect({host:'127.0.0.1',port:runtime.httpsPort,servername:'direct.test',ca:cert});
  socket.on('error',()=>{});await once(socket,'secureConnect');
  const ended=once(socket,'close');allowed=false;app.admit(0);await ended;
  await assert.rejects(new Promise((resolve,reject)=>{
    const wrong=tls.connect({host:'127.0.0.1',port:runtime.httpsPort,servername:'other.test',ca:cert});
    wrong.once('secureConnect',()=>{wrong.destroy();resolve();});wrong.once('error',reject);
  }));
});
test('direct SOCKS egress dials the checked IP and accounts app traffic without a TUNA process',async t=>{
  const echo=net.createServer(s=>s.pipe(s));await new Promise(r=>echo.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>echo.close(r)));
  const bytes={in:0,out:0},dialed=[];
  const egress=await createDirectEgress({authorize:()=>true,meter:{consume:async(d,n)=>{bytes[d]+=n;}},
    resolve:async()=>[{address:'8.8.8.8',family:4}],connect:options=>{dialed.push(options);return net.connect(echo.address().port,'127.0.0.1');}});
  t.after(()=>egress.close());
  const socket=await connectSOCKS('127.0.0.1:'+egress.port,'echo.example',443);socket.on('error',()=>{});
  socket.write('hello');const [reply]=await once(socket,'data');assert.equal(reply.toString(),'hello');socket.destroy();
  assert.equal(dialed[0].host,'8.8.8.8');assert.deepEqual(bytes,{in:5,out:5});
  await assert.rejects(connectSOCKS('127.0.0.1:'+egress.port,'127.0.0.1',443),/refused/);
});
