import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveDesktopWorker, parseDesktopWorkerLine, MAX_STREAMS, startDesktopWorkerTransport } from './desktop-worker-transport.mjs';
import { bridgeAuthLine } from './bridge-auth.mjs';

const expect = { appID: '1'.repeat(64), profileSHA: '2'.repeat(64), gpuMilli: 500 };
const credential = '3'.repeat(64);
const claim = (x = {}) => { const v = { boot:'4'.repeat(32), claim:'5'.repeat(64), ...expect, ...x }; return `native-worker-v1 claim ${v.boot} ${v.claim} ${v.appID} ${v.profileSHA} ${v.gpuMilli}\n`; };
async function until(f) { const end=Date.now()+1500; while(!f()) { if(Date.now()>end) throw new Error('condition timed out'); await sleep(2); } }
class Reader {
  constructor(c) { this.buf=Buffer.alloc(0); this.ended=false; this.pending=null;
    c.on('data',b=>{this.buf=Buffer.concat([this.buf,b]);this.pump();});
    c.on('end',()=>{this.ended=true;this.pump();}); c.on('close',()=>{this.ended=true;this.pump();});c.on('error',()=>{});
  }
  pump(){if(!this.pending)return;let {n,resolve,reject}=this.pending;const len=n===null?this.buf.indexOf(10)+1:n;
    if(len>0&&this.buf.length>=len){this.pending=null;const b=this.buf.subarray(0,len);this.buf=this.buf.subarray(len);resolve(b);}
    else if(this.ended){this.pending=null;reject(new Error('closed'));}}
  take(n){assert.equal(this.pending,null);return new Promise((resolve,reject)=>{this.pending={n,resolve,reject};this.pump();});}
  async line(){return (await this.take(null)).toString();}
}
async function connect(h,line,cred=credential){const c=net.connect(h.port,'127.0.0.1');const r=new Reader(c);await new Promise((res,rej)=>{c.once('connect',res);c.once('error',rej);});c.write(bridgeAuthLine(cred)+line);return {c,r};}
async function lease(h,x={}) {const v=await connect(h,claim(x));const line=await v.r.line();assert.match(line,/^native-worker-v1 lease [0-9a-f]{64}\n$/);return {...v,token:line.split(' ')[2].trim()};}
async function stream(h,token){const v=await connect(h,`native-worker-v1 open ${token}\n`);assert.equal(await v.r.line(),'native-worker-v1 stream\n');return v;}
async function fixture(t,opts={}) {const h=await serveDesktopWorker({expect,credential,handshakeMs:200,authTimeoutMs:100,...opts});t.after(()=>h.close());return h;}
async function worker(t,onConnection=c=>c.pipe(c)){const sockets=new Set();const s=net.createServer(c=>{sockets.add(c);c.on('error',()=>{});c.on('close',()=>sockets.delete(c));onConnection(c);});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.close(r);for(const c of sockets)c.destroy();}));return s.address().port;}
const options={timeout:5000};

test('strict frame parsing and binding geometry',()=>{
 assert.equal(parseDesktopWorkerLine(Buffer.from(claim())).op,'claim');
 assert.equal(parseDesktopWorkerLine(Buffer.from(`native-worker-v1 open ${'a'.repeat(64)}\n`)).op,'open');
 for(const s of [claim()+'\n',claim()+'x',claim().replace(' claim ','\tclaim '),claim({boot:'0'.repeat(32)}),claim({appID:'A'.repeat(64)}),claim({claim:'0'.repeat(64)}),claim({profileSHA:'0'.repeat(64)}),claim({gpuMilli:499}),claim({gpuMilli:1001}),claim({gpuMilli:'0500'}),'x'.repeat(513),`native-worker-v1 open ${'0'.repeat(64)}\n`,`native-worker-v1 open ${'a'.repeat(64)}\n\n`])assert.throws(()=>parseDesktopWorkerLine(Buffer.from(s)));
});

test('authenticated claim, exact allocation and one-time use',options,async t=>{
 const port=await worker(t);const h=await fixture(t,{workerPort:port});
 for(const [line,cred] of [[claim(), '9'.repeat(64)],[claim({appID:'6'.repeat(64)}),credential],[claim({profileSHA:'7'.repeat(64)}),credential],[claim({gpuMilli:501}),credential]]){
  const v=await connect(h,line,cred);await assert.rejects(v.r.line(),/closed/);assert.equal(h.stats().claimed,false);
 }
 const l=await lease(h);const duplicate=await connect(h,claim());await assert.rejects(duplicate.r.line(),/closed/);
 const wrong=await connect(h,`native-worker-v1 open ${'f'.repeat(64)}\n`);await assert.rejects(wrong.r.line(),/closed/);
 const v=await stream(h,l.token);const payload=Buffer.from([0,255,1,2,3,4]);v.c.write(payload);assert.deepEqual(await v.r.take(payload.length),payload);
 assert.equal(h.stats().accepted,1);assert.equal(JSON.stringify(h.stats()).includes(l.token),false);
 v.c.destroy();l.c.destroy();
});

test('control EOF or unexpected data irrevocably revoke every stream',options,async t=>{
 for(const why of ['close','data'])await t.test(why,options,async t=>{
  const port=await worker(t);const h=await fixture(t,{workerPort:port});const l=await lease(h);const v=await stream(h,l.token);
  if(why==='close')l.c.end();else l.c.write('unexpected');
  await assert.rejects(v.r.take(1),/closed/);await until(()=>h.stats().terminal&&h.stats().streams===0);
  for(const line of [claim(),claim({claim:'8'.repeat(64)}),`native-worker-v1 open ${l.token}\n`]){const r=await connect(h,line);await assert.rejects(r.r.line(),/closed/);}
  assert.equal(h.stats().accepted,1);
 });
});

test('eight pending dials consume slots, canceled slot is reusable',options,async t=>{
 let calls=0;const h=await fixture(t,{handshakeMs:1500,connectWorker:signal=>new Promise((resolve,reject)=>{calls++;signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});if(signal.aborted)reject(new Error('aborted'));})});
 const l=await lease(h), pending=[];
 for(let i=0;i<MAX_STREAMS;i++)pending.push(await connect(h,`native-worker-v1 open ${l.token}\n`));
 await until(()=>calls===8);assert.equal(h.stats().streams,8);
 const extra=await connect(h,`native-worker-v1 open ${l.token}\n`);await assert.rejects(extra.r.line(),/closed/);assert.equal(calls,8);
 pending[0].c.destroy();await until(()=>h.stats().streams===7);
 pending.push(await connect(h,`native-worker-v1 open ${l.token}\n`));await until(()=>calls===9);assert.equal(h.stats().streams,8);
 await h.close();assert.equal(h.stats().streams,0);for(const v of pending)v.c.destroy();
});

test('late dial completion after revoke is destroyed and drained before close returns',options,async t=>{
 const port=await worker(t);let resolveDial,started=false;
 const h=await fixture(t,{connectWorker:()=>new Promise(r=>{resolveDial=r;started=true;})});
 const l=await lease(h);const v=await connect(h,`native-worker-v1 open ${l.token}\n`);await until(()=>started);
 l.c.destroy();await assert.rejects(v.r.line(),/closed/);
 let finished=false;const closing=h.close().then(()=>{finished=true;});await sleep(10);assert.equal(finished,false);
 const upstream=net.connect(port,'127.0.0.1');upstream.on('error',()=>{});await new Promise(r=>upstream.once('connect',r));resolveDial(upstream);
 await closing;assert.equal(upstream.destroyed,true);assert.equal(h.stats().streams,0);assert.equal(h.stats().accepted,0);
});

test('stream acknowledgment preserves large coalesced worker output and orderly EOF',options,async t=>{
 const payload=Buffer.alloc(1024*1024,0xa5);const port=await worker(t,c=>c.end(payload));const h=await fixture(t,{workerPort:port});
 const l=await lease(h);const v=await stream(h,l.token);assert.deepEqual(await v.r.take(payload.length),payload);await assert.rejects(v.r.take(1),/closed/);l.c.destroy();
});

test('bounded incomplete header and failed worker do not leak slots',options,async t=>{
 const h=await fixture(t,{handshakeMs:30,connectWorker:async()=>{throw new Error('offline');}});const partial=await connect(h,'native-worker-v1');await assert.rejects(partial.r.line(),/closed/);assert.equal(h.stats().claimed,false);
 const l=await lease(h);for(let i=0;i<12;i++){const v=await connect(h,`native-worker-v1 open ${l.token}\n`);await assert.rejects(v.r.line(),/closed/);await until(()=>h.stats().streams===0);}assert.equal(h.stats().accepted,0);l.c.destroy();
});

test('invalid runtime pin and profile fail before spawning a bridge',options,async()=>{
 const args={bridge:{exe:'/not-opened',sha256:'a'.repeat(64)},vmId:'11111111-1111-1111-1111-111111111111',mapping:{appId:expect.appID,record:{runtimeId:'b'.repeat(64),desktop:{profile:'kvm-box-masked-v1',profileSha256:expect.profileSHA,gpuMilli:500}}},runtimeId:'c'.repeat(64),spawn:()=>assert.fail('must not spawn')};
 await assert.rejects(startDesktopWorkerTransport(args),/selected desktop runtime/);
 await assert.rejects(startDesktopWorkerTransport({...args,runtimeId:'b'.repeat(64)+'\n'}),/selected desktop runtime/);
 await assert.rejects(startDesktopWorkerTransport({...args,vmId:args.vmId+'\n'}),/partition id/);
});

function fakeBridge(t,{ready=true,holdExit=false}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-bridge-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const exe=path.join(dir,'pinned-fixture');fs.writeFileSync(exe,'public bridge fixture');
 const sha256=crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
 const seen={};
 const spawn=(file,args,opts)=>{
  assert.equal(file,exe);assert.equal(args[4],'--worker-auth-stdin');assert.deepEqual(opts.stdio,['pipe','pipe','pipe']);
  seen.args=args;seen.port=Number(args[2]);
  const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();
  c.stdin.once('data',b=>{seen.auth=b.toString();assert.match(seen.auth,/^enclave-bridge-auth-v1 [0-9a-f]{64}\n$/);assert.equal(args.join(' ').includes(seen.auth.trim().split(' ')[1]),false);});
  let exited=false;const exit=()=>{if(!exited){exited=true;c.emit('exit',0,null);}};
  seen.exit=exit;seen.child=c;c.kill=exit;if(!holdExit)c.stdin.once('close',exit);
  queueMicrotask(()=>{if(ready)c.stdout.write('shielded bridge ready\n');else exit();});return c;
 };
 return {bridge:{exe,sha256},spawn,seen};
}

test('pinned bridge wrapper delivers credential through stdin and owns cleanup',options,async t=>{
 const port=await worker(t);const f=fakeBridge(t);const runtimeId='b'.repeat(64);
 const handle=await startDesktopWorkerTransport({...f,vmId:'11111111-1111-1111-1111-111111111111',workerPort:port,runtimeId,
 mapping:{appId:expect.appID,record:{runtimeId,desktop:{profile:'kvm-box-masked-v1',profileSha256:expect.profileSHA,gpuMilli:500}}}});
 const cred=f.seen.auth.trim().split(' ')[1];const h={port:f.seen.port};
 const v=await connect(h,claim(),cred);assert.match(await v.r.line(),/^native-worker-v1 lease [0-9a-f]{64}\n$/);
 await Promise.all([handle.stop(),handle.stop()]);await assert.rejects(v.r.take(1),/closed/);assert.equal(handle.stats().terminal,true);
});

test('bridge startup failure closes its listener',options,async t=>{
 const f=fakeBridge(t,{ready:false});const runtimeId='b'.repeat(64);
 await assert.rejects(startDesktopWorkerTransport({...f,vmId:'11111111-1111-1111-1111-111111111111',runtimeId,
 mapping:{appId:expect.appID,record:{runtimeId,desktop:{profile:'kvm-box-masked-v1',profileSha256:expect.profileSHA,gpuMilli:500}}}}),/bridge exited/);
 const c=net.connect(f.seen.port,'127.0.0.1');await new Promise(resolve=>c.once('error',resolve));c.destroy();
});

test('lease loss notifies the launcher while cleanup waits for the actual bridge exit',options,async t=>{
 const f=fakeBridge(t,{holdExit:true});const runtimeId='b'.repeat(64);
 const handle=await startDesktopWorkerTransport({...f,vmId:'11111111-1111-1111-1111-111111111111',runtimeId,
 mapping:{appId:expect.appID,record:{runtimeId,desktop:{profile:'kvm-box-masked-v1',profileSha256:expect.profileSHA,gpuMilli:500}}}});
 t.after(async()=>{f.seen.exit();await handle.stop();});
 const cred=f.seen.auth.trim().split(' ')[1];const v=await connect({port:f.seen.port},claim(),cred);
 assert.match(await v.r.line(),/^native-worker-v1 lease [0-9a-f]{64}\n$/);
 v.c.end();
 assert.deepEqual(await handle.exited,{error:'native worker lease revoked'});
 let stopped=false;const cleanup=handle.stop().then(()=>{stopped=true;});
 await sleep(10);assert.equal(stopped,false,'revocation is not bridge reaping');
 assert.equal(f.seen.child.stdin.destroyed,true);
 f.seen.exit();await cleanup;assert.equal(stopped,true);
 const c=net.connect(f.seen.port,'127.0.0.1');await new Promise(resolve=>c.once('error',resolve));c.destroy();
});
