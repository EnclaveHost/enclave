// Custom domains and plaintext redirects use the local TUNA host adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {TunaHost} from '../network/tuna-host.mjs';
import {resolveHostname} from '../network/agent.mjs';
const id='0xcc1f4f3f'+'cd'.repeat(28), zone='app.test', custom='shop.example.com';
const domains={[custom]:id,['evil.'+zone]:id,'bad.example.com':'not-an-id'};
const admitted={[id]:{}};
const resolveName=name=>resolveHostname(name,domains,admitted,zone);
function fakeProcess(){
 const child=new EventEmitter();
 child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
 child.kill=()=>{child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.emit('exit',0);};return child;
}
function request(port,hostname,path='/'){
 return new Promise((resolve,reject)=>{
  const r=http.get({host:'127.0.0.1',port,path,headers:{host:hostname},agent:false},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,headers:res.headers}));});
  r.on('error',reject);
 });
}
function raw(port,payload){
 return new Promise((resolve,reject)=>{
  const s=net.connect(port,'127.0.0.1');let out='';s.setTimeout(2000,()=>s.destroy());
  s.on('connect',()=>s.write(payload));s.on('data',b=>out+=b);s.on('error',reject);s.on('close',()=>resolve(out));
 });
}
test('custom map cannot shadow the app zone or supply malformed deployment ids',()=>{
 assert.equal(resolveName(custom),id);
 assert.equal(resolveName('cc1f4f3f.'+zone),id);
 for(const name of ['evil.'+zone,zone,'bad.example.com','unknown.example.org','constructor'])assert.equal(resolveName(name),null);
 const collision={...admitted,['0xcc1f4f3f'+'ab'.repeat(28)]:{}};
 assert.equal(resolveHostname('cc1f4f3f.'+zone,{},collision,zone),null);
});
test('HTTP redirect and HTTPS share a provider allocation and enforce current app admission',async t=>{
 let allowed=true;
 const h=new TunaHost({config:'test',webPort:0,httpPort:0,deployments:()=>[],resolveName,isAllowed:()=>allowed,
  serveHttps:s=>s.destroy(),spawnProcess:fakeProcess,log:()=>{}});
 t.after(()=>h.close());await h.start();
 assert.deepEqual(h.routes.get('web').tcp,[h.webPort,h.httpPort]);
 for(const hostname of [custom,'cc1f4f3f.'+zone]){
  const r=await request(h.httpPort,hostname,'/cart?item=7');assert.equal(r.status,308);
  assert.equal(r.headers.location,'https://'+hostname+'/cart?item=7');
 }
 for(const hostname of ['evil.'+zone,'bad.example.com','unknown.example.org']){
  const r=await request(h.httpPort,hostname);assert.equal(r.status,421);assert.equal(r.headers.location,undefined);
 }
 allowed=false;assert.equal((await request(h.httpPort,custom)).status,421);
 allowed=true;
 assert.equal((await request(h.httpPort,custom,'http://other/')).status,400);
 for(const payload of [
  `GET /x\nX-Injected: yes HTTP/1.1\r\nHost: ${custom}\r\n\r\n`,
  `GET / HTTP/1.1\r\nHost: ${custom}\nLocation: https://evil.example\r\n\r\n`,
 ])assert.doesNotMatch(await raw(h.httpPort,payload), /X-Injected|evil\.example/i);
 assert.equal(await raw(h.httpPort,`GET / HTTP/1.1\r\nHost: ${custom}\r\nX-Pad: ${'a'.repeat(9000)}\r\n\r\n`),'');
});
