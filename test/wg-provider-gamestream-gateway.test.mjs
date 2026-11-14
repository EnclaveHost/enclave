// The standalone GameStream gateway (network/wg-provider/gamestream-gateway.mjs): which names it will carry, what its
// configuration accepts, and that every tunnel goes to the one configured router. The router and the app's front are a
// local stand-in speaking the port tunnel without TLS (as in wg-provider-gamestream.test.mjs).
import test from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import {once} from 'node:events';import {execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {parseGatewayConfig,zoneRoute,limitedLog,startGateway} from '../network/wg-provider/gamestream-gateway.mjs';

const frame=b=>{const h=Buffer.alloc(2);h.writeUInt16BE(b.length);return Buffer.concat([h,b]);};
async function front(){
 const seen=[],sockets=new Set();
 const server=net.createServer(s=>{
  sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));
  let buf=Buffer.alloc(0),tag=null;
  s.on('data',chunk=>{
   buf=Buffer.concat([buf,chunk]);
   if(!tag){
    const end=buf.indexOf('\r\n\r\n');if(end<0)return;
    const m=/^GET \/\.well-known\/enclave-tunnel\/(tcp|udp)\/(\d+) HTTP\/1\.1\r\nHost: ([^\r\n]+)\r\n/.exec(buf.subarray(0,end+2).toString('latin1'));
    if(!m)return s.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    tag=`${m[3]}|${m[1]}/${m[2]}|`;seen.push(tag);buf=buf.subarray(end+4);
    s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: enclave-port/1\r\n\r\n');
   }
   while(buf.length>=2){
    const n=buf.readUInt16BE(0);if(buf.length<2+n)break;const payload=buf.subarray(2,2+n);buf=buf.subarray(2+n);
    s.write(n?frame(Buffer.concat([Buffer.from(tag),payload])):frame(Buffer.alloc(0)));
   }
  });
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {port:server.address().port,seen,close(){server.close();for(const s of sockets)s.destroy();}};
}
async function tcp(port,from,bytes){
 const s=net.connect({port,host:'127.0.0.1',localAddress:from});s.on('error',()=>{});
 const chunks=[];s.on('data',c=>chunks.push(c));
 await once(s,'connect');s.end(bytes);
 await once(s,'close');return Buffer.concat(chunks).toString('latin1');
}
const get=host=>`GET /serverinfo HTTP/1.1\r\nHost: ${host}\r\n\r\n`;

test('a name is carried only when it is one label under a configured zone',()=>{
 const route=zoneRoute(['app.enclave.host','app.example.org'],'127.0.0.1');
 for(const name of ['9a28642b.app.enclave.host','desk-1.app.example.org','a.app.enclave.host'])assert.equal(route(name),'127.0.0.1',name);
 for(const name of ['app.enclave.host','enclave.host','x.y.app.enclave.host','xapp.enclave.host','9a28642b.app.enclave.host.attacker.test',
   'attacker.test','203.0.113.7','127.0.0.1','localhost','','.app.enclave.host','-a.app.enclave.host','a-.app.enclave.host','a_b.app.enclave.host',
   'A.app.enclave.host','a.app.enclave.host.','a b.app.enclave.host','a\r\nx: y.app.enclave.host','a/..app.enclave.host','x'.repeat(64)+'.app.enclave.host',
   null,undefined,7,{host:'127.0.0.1'}])assert.equal(route(name),null,String(name));
});

test('the configuration: defaults, and nothing it does not know',()=>{
 assert.deepEqual(parseGatewayConfig({zones:['app.enclave.host'],host:'203.0.113.9'}),
  {zones:['app.enclave.host'],router:'127.0.0.1',host:'203.0.113.9',maxFlows:256,maxPerClient:32,maxBindings:4096});
 assert.deepEqual(parseGatewayConfig({zones:['a.test','a.test'],router:'10.0.0.1',host:'0.0.0.0',maxFlows:8,maxPerClient:2,maxBindings:16}),
  {zones:['a.test'],router:'10.0.0.1',host:'0.0.0.0',maxFlows:8,maxPerClient:2,maxBindings:16});
 const ok={zones:['app.enclave.host'],host:'203.0.113.9'};
 for(const [bad,why] of [[null,/object/],[[],/object/],[{...ok,keyFile:'/x'},/unknown field keyFile/],[{...ok,ports:{}},/unknown field ports/],
   [{host:ok.host},/zones/],[{...ok,zones:[]},/zones/],[{...ok,zones:['host']},/zones/],[{...ok,zones:['App.test']},/zones/],[{...ok,zones:['*.app.test']},/zones/],
   [{...ok,zones:['.app.test']},/zones/],[{...ok,zones:[7]},/zones/],[{...ok,zones:Array(9).fill('a.test')},/zones/],
   [{zones:ok.zones},/host/],[{...ok,host:'edge.test'},/host/],[{...ok,host:'::'},/host/],[{...ok,host:'256.1.1.1'},/host/],
   [{...ok,router:'localhost'},/router/],[{...ok,router:'10.0.0.1:444'},/router/],
   [{...ok,maxFlows:0},/maxFlows/],[{...ok,maxFlows:4097},/maxFlows/],[{...ok,maxPerClient:1.5},/maxPerClient/],[{...ok,maxBindings:'9'},/maxBindings/]])
  assert.throws(()=>parseGatewayConfig(bad),why,JSON.stringify(bad));
});

test('flows under a zone name go to the router under that name; any other name opens nothing',async()=>{
 const f=await front(),asked=[],lines=[];
 const g=await startGateway(parseGatewayConfig({zones:['app.test'],router:'127.0.0.9',host:'127.0.0.1',maxPerClient:4}),{log:l=>lines.push(l),ports:{http:0,https:0,rtsp:0,udp:[0,0,0]},
  connect:async(to,name)=>{asked.push(to+' '+name);const s=net.connect(f.port,'127.0.0.1');await once(s,'connect');return s;}});
 try{
  assert.match(lines[0],/^gamestream gateway: 127\.0\.0\.1 TCP \d+, \d+, \d+ and UDP \d+, \d+, \d+ for \*\.app\.test through 127\.0\.0\.9:443$/);
  for(const host of ['other.test','desk.app.test.attacker.test','a.b.app.test','203.0.113.7:47989'])assert.equal(await tcp(g.ports.http,'127.0.0.2',get(host)),'',host);
  assert.equal(await tcp(g.ports.rtsp,'127.0.0.2','x'),'');
  assert.deepEqual(asked,[]);assert.deepEqual(f.seen,[]);assert.equal(g.bindings.size,0);
  assert.equal(await tcp(g.ports.http,'127.0.0.2',get('desk.app.test:47989')),'desk.app.test|tcp/47989|'+get('desk.app.test:47989'));
  assert.equal(await tcp(g.ports.rtsp,'127.0.0.2','x'),'desk.app.test|tcp/48010|x');
  assert.equal(await tcp(g.ports.rtsp,'127.0.0.3','x'),'');
  assert.deepEqual(asked,['127.0.0.9 desk.app.test','127.0.0.9 desk.app.test']);
 }finally{g.close();f.close();}
});

test('a name under a zone that the router does not serve binds its client and reaches nothing',async()=>{
 const lines=[];
 const g=await startGateway(parseGatewayConfig({zones:['app.test'],host:'127.0.0.1'}),{log:l=>lines.push(l),ports:{http:0,https:0,rtsp:0,udp:[0,0,0]},
  connect:async()=>{throw Error('connect ECONNRESET');}});
 try{
  assert.equal(await tcp(g.ports.http,'127.0.0.2',get('gone.app.test')),'');
  assert.equal(await tcp(g.ports.rtsp,'127.0.0.2','x'),'');
  assert.deepEqual([...g.bindings.keys()],['127.0.0.2']);assert.equal(g.stats().flows,0);
  assert.deepEqual(lines.slice(1),['gamestream gone.app.test tcp/47989: connect ECONNRESET','gamestream gone.app.test tcp/48010: connect ECONNRESET']);
 }finally{g.close();}
});

test('the log is bounded: a burst a minute, then a count of what was left out',()=>{
 let clock=0;const out=[],log=limitedLog(l=>out.push(l),{burst:3,now:()=>clock});
 for(let i=0;i<10;i++)log('line '+i);
 assert.deepEqual(out,['line 0','line 1','line 2']);
 clock=60000;log('later');
 assert.deepEqual(out.slice(3),['(7 more lines not logged in the last minute)','later']);
});

test('the entry checks a configuration without listening, and refuses a bad one',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'gsgw-')),entry=new URL('../network/wg-provider/gamestream-gateway-main.mjs',import.meta.url).pathname;
 const run=args=>new Promise(resolve=>execFile(process.execPath,[entry,...args],(error,stdout,stderr)=>resolve({code:error?error.code:0,stdout,stderr})));
 try{
  const good=path.join(dir,'good.json'),bad=path.join(dir,'bad.json');
  await writeFile(good,JSON.stringify({zones:['app.test'],host:'127.0.0.1'}));await writeFile(bad,JSON.stringify({zones:['app.test'],host:'127.0.0.1',registryKey:'x'}));
  const a=await run(['--check-config',good]);
  assert.equal(a.code,0);assert.deepEqual(JSON.parse(a.stdout),{ok:true,zones:['app.test'],router:'127.0.0.1',host:'127.0.0.1',maxFlows:256,maxPerClient:32,maxBindings:4096});
  const b=await run(['--check-config',bad]);assert.equal(b.code,1);assert.match(b.stderr,/configuration rejected: unknown field registryKey/);
  const c=await run(['--check-config',path.join(dir,'missing.json')]);assert.equal(c.code,1);assert.match(c.stderr,/configuration rejected/);
  assert.equal((await run([])).code,2);assert.equal((await run([good,good])).code,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
