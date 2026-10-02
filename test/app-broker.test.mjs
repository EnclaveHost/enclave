import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import tls from 'node:tls';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {createAppBroker} from '../network/app-broker.mjs';import {spliceAppBroker} from '../network/broker-client.mjs';import {createAppIngress} from '../network/app-ingress.mjs';

test('a complete guest TLS handshake and bytes traverse app-bound IPC without localhost TCP',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'app-ipc-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',dir+'/key','-out',dir+'/cert','-days','1','-subj','/CN=app.example'],{stdio:'ignore'});
 const cert=await fs.readFile(dir+'/cert'),key=await fs.readFile(dir+'/key');
 const guest=tls.createServer({key,cert},socket=>socket.pipe(socket));await new Promise(r=>guest.listen(0,'127.0.0.1',r));t.after(()=>guest.close());
 const id='0x'+'ab'.repeat(32);let allowed=true;
 const broker=await createAppBroker({socketPath:dir+'/app.sock',deploymentId:id,authorize:()=>allowed,forward:(stream,app)=>{
  assert.equal(app,id);const upstream=net.connect({host:'127.0.0.1',port:guest.address().port});stream.pipe(upstream).pipe(stream);stream.once('close',()=>upstream.destroy());upstream.on('error',()=>stream.destroy());
 }});t.after(()=>broker.close());
 const ingress=await createAppIngress({deploymentId:id,names:['app.example'],authorize:()=>allowed,forward:socket=>spliceAppBroker(socket,dir+'/app.sock')});t.after(()=>ingress.close());
 const client=tls.connect({host:'127.0.0.1',port:ingress.port,servername:'app.example',ca:cert});client.on('error',()=>{});t.after(()=>client.destroy());
 await new Promise((r,j)=>{client.once('secureConnect',r);client.once('error',j)});
 const received=new Promise(r=>client.once('data',r));client.write('app-bound TLS');assert.equal((await received).toString(),'app-bound TLS');
 const closed=new Promise(r=>client.once('close',r));allowed=false;broker.revoke();await closed;assert.equal(client.destroyed,true);
});

test('only an app-bound listener accepts SNI-less TLS; foreign SNI is refused',async t=>{
 const id='0x'+'ab'.repeat(32);let forwarded=0;
 const ingress=await createAppIngress({deploymentId:id,names:['app.example'],allowNoSni:true,authorize:()=>true,forward:socket=>{forwarded++;socket.destroy();}});t.after(()=>ingress.close());
 const attempt=servername=>new Promise(resolve=>{const socket=tls.connect({host:'127.0.0.1',port:ingress.port,servername});socket.on('error',()=>{});socket.once('close',resolve);});
 await attempt('');assert.equal(forwarded,1);
 await attempt('another-app.example');assert.equal(forwarded,1);
 await attempt('app.example');assert.equal(forwarded,2);
 const strict=await createAppIngress({deploymentId:id,names:['app.example'],authorize:()=>true,forward:socket=>{forwarded++;socket.destroy();}});t.after(()=>strict.close());
 await new Promise(resolve=>{const socket=tls.connect({host:'127.0.0.1',port:strict.port,servername:''});socket.on('error',()=>{});socket.once('close',resolve);});assert.equal(forwarded,2);
});
test('Windows loopback broker requires its own secret and cannot select another app',async t=>{
 const {default:WebSocket}=await import('ws');const id='0x'+'ab'.repeat(32),token='cd'.repeat(32);let forwards=0,allowed=true;
 const broker=await createAppBroker({tcpPort:0,token,deploymentId:id,authorize:()=>allowed,forward:(stream,app)=>{assert.equal(app,id);forwards++;stream.pipe(stream);}});t.after(()=>broker.close());
 const connect=key=>new WebSocket('ws://127.0.0.1:'+broker.port+'/app',{headers:{'x-enclave-broker':key,'x-deployment':'0x'+'ef'.repeat(32)}});
 for(const key of ['', 'ef'.repeat(32), 'z'.repeat(64)]){const ws=connect(key);ws.on('error',()=>{});await new Promise(r=>ws.once('close',r));}
 assert.equal(forwards,0);const ws=connect(token);ws.on('error',()=>{});t.after(()=>ws.terminate());await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
 const echoed=new Promise(r=>ws.once('message',r));ws.send('bound app');assert.equal((await echoed).toString(),'bound app');assert.equal(forwards,1);
 const closed=new Promise(r=>ws.once('close',r));allowed=false;broker.revoke();await closed;
});
