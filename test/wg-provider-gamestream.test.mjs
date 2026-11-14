// The provider's public GameStream ingress (network/wg-provider/gamestream.mjs): which app a flow reaches, and that a
// flow without a name or a binding reaches none. The app's front is a local stand-in speaking the port tunnel
// (isolation/m2/front/tunnel.go) without TLS; clients differ by loopback source address.
import test from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import tls from 'node:tls';import dgram from 'node:dgram';import {once} from 'node:events';
import {createGameStream,openTunnel} from '../network/wg-provider/gamestream.mjs';

const frame=b=>{const h=Buffer.alloc(2);h.writeUInt16BE(b.length);return Buffer.concat([h,b]);};
const DECLARED=new Set(['tcp/47984','tcp/47989','tcp/48010','udp/47998','udp/47999','udp/48000']);
// a front: answers the upgrade for declared ports, then echoes every frame back behind "<host>|<proto>/<port>|"; a
// zero-length TCP frame (the client's half-close) is answered with one
async function front(){
 const seen=[],sockets=new Set();
 const server=net.createServer(s=>{
  sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));
  let buf=Buffer.alloc(0),tag=null,proto;
  s.on('data',chunk=>{
   buf=Buffer.concat([buf,chunk]);
   if(!tag){
    const end=buf.indexOf('\r\n\r\n');if(end<0)return;
    const head=buf.subarray(0,end).toString('latin1'),m=/^GET \/\.well-known\/enclave-tunnel\/(tcp|udp)\/(\d+) HTTP\/1\.1\r\nHost: ([^\r\n]+)\r\nConnection: Upgrade\r\nUpgrade: enclave-port\/1$/.exec(head);
    if(!m||!DECLARED.has(m[1]+'/'+m[2]))return s.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    proto=m[1];tag=`${m[3]}|${m[1]}/${m[2]}|`;seen.push(tag);buf=buf.subarray(end+4);
    s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: enclave-port/1\r\n\r\n');
   }
   while(buf.length>=2){
    const n=buf.readUInt16BE(0);if(buf.length<2+n)break;const payload=buf.subarray(2,2+n);buf=buf.subarray(2+n);
    if(proto==='tcp'&&!n)s.write(frame(Buffer.alloc(0)));else s.write(frame(Buffer.concat([Buffer.from(tag),payload])));
   }
  });
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {port:server.address().port,seen,close(){server.close();for(const s of sockets)s.destroy();}};
}
async function rig(over={}){
 const f=await front();let clock=1_000_000;const counted=[];
 const routes=new Map([['desk.app.test','10.9.0.2'],['other.app.test','10.9.0.3'],['custodian.test',{host:'127.0.0.1',tls:1,http:1}]]);
 const g=await createGameStream({route:n=>routes.get(n)||null,host:'127.0.0.1',ports:{http:0,https:0,rtsp:0,udp:[0,0,0]},now:()=>clock,
  count:(to,up,down)=>counted.push([to,up,down]),connect:async()=>{const s=net.connect(f.port,'127.0.0.1');await once(s,'connect');return s;},...over});
 return {f,g,counted,advance:ms=>{clock+=ms;},close(){g.close();f.close();}};
}
// one TCP exchange from a loopback source address: write, half-close, read to the end ('' when the gateway closes it)
async function tcp(port,from,bytes){
 const s=net.connect({port,host:'127.0.0.1',localAddress:from});s.on('error',()=>{});
 const chunks=[];s.on('data',c=>chunks.push(c));
 await once(s,'connect');if(bytes)s.end(bytes);
 await once(s,'close');return Buffer.concat(chunks).toString('latin1');
}
const get=(host)=>`GET /serverinfo HTTP/1.1\r\nHost: ${host}\r\n\r\n`;

test('HTTP 47989 reaches the app its Host names, and binds the client: RTSP and a nameless request follow',async()=>{
 const r=await rig();
 try{
  const a=await tcp(r.g.ports.http,'127.0.0.2',get('desk.app.test:47989'));
  assert.equal(a,'desk.app.test|tcp/47989|'+get('desk.app.test:47989'));
  assert.equal(await tcp(r.g.ports.rtsp,'127.0.0.2','OPTIONS rtsp://x RTSP/1.0\r\n\r\n'),'desk.app.test|tcp/48010|OPTIONS rtsp://x RTSP/1.0\r\n\r\n');
  // the PC added by address: Host is an address no peer holds
  assert.equal(await tcp(r.g.ports.http,'127.0.0.2',get('203.0.113.7:47989')),'desk.app.test|tcp/47989|'+get('203.0.113.7:47989'));
  // bytes are metered against the peer in both directions
  assert.ok(r.counted.every(([to])=>to==='10.9.0.2'));
  assert.ok(r.counted.some(([,up])=>up>0)&&r.counted.some(([,,down])=>down>0));
  assert.equal(r.g.stats().flows,0);
 }finally{r.close();}
});

test('no name and no binding reaches nothing: RTSP, an address in Host, a name no peer holds, a name served on this box',async()=>{
 const r=await rig();
 try{
  assert.equal(await tcp(r.g.ports.rtsp,'127.0.0.3','OPTIONS rtsp://x RTSP/1.0\r\n\r\n'),'');
  assert.equal(await tcp(r.g.ports.http,'127.0.0.3',get('203.0.113.7:47989')),'');
  assert.equal(await tcp(r.g.ports.http,'127.0.0.3',get('unknown.app.test')),'');
  assert.equal(await tcp(r.g.ports.http,'127.0.0.3',get('custodian.test')),'');
  assert.equal(await tcp(r.g.ports.rtsp,'127.0.0.3','x'),'');
  assert.deepEqual(r.f.seen,[]);assert.equal(r.g.bindings.size,0);
  // another client's binding is not this client's
  await tcp(r.g.ports.http,'127.0.0.2',get('desk.app.test'));
  assert.equal(await tcp(r.g.ports.rtsp,'127.0.0.3','x'),'');
 }finally{r.close();}
});

test('TLS 47984 is named by SNI and binds the client; a later name moves the binding',async()=>{
 const r=await rig();
 try{
  const hello=localAddress=>new Promise(resolve=>{const s=tls.connect({host:'127.0.0.1',port:r.g.ports.https,servername:'desk.app.test',localAddress});s.on('error',()=>resolve());s.on('close',()=>resolve());});
  await hello('127.0.0.4');
  assert.deepEqual(r.f.seen,['desk.app.test|tcp/47984|']);
  assert.equal(await tcp(r.g.ports.rtsp,'127.0.0.4','x'),'desk.app.test|tcp/48010|x');
  await tcp(r.g.ports.http,'127.0.0.4',get('other.app.test'));
  assert.equal(await tcp(r.g.ports.rtsp,'127.0.0.4','x'),'other.app.test|tcp/48010|x');
 }finally{r.close();}
});

test('UDP follows the binding with datagram boundaries kept, and is dropped without one',async()=>{
 const r=await rig(),sock=dgram.createSocket('udp4');
 try{
  sock.bind(0,'127.0.0.5');await once(sock,'listening');
  const got=[];sock.on('message',m=>got.push(m.toString('latin1')));
  const settle=()=>new Promise(resolve=>setTimeout(resolve,150));
  sock.send(Buffer.from('early'),r.g.ports.udp[0],'127.0.0.1');await settle();
  assert.deepEqual(got,[]);assert.deepEqual(r.f.seen,[]);
  await tcp(r.g.ports.http,'127.0.0.5',get('desk.app.test'));
  const big='v'.repeat(1400);
  for(const m of ['one','',big])sock.send(Buffer.from(m),r.g.ports.udp[1],'127.0.0.1');
  for(let i=0;i<40&&got.length<3;i++)await settle();
  assert.deepEqual(got,['one','',big].map(m=>'desk.app.test|udp/47999|'+m));
  // one association: one tunnel for the three datagrams
  assert.equal(r.f.seen.filter(t=>t.includes('udp/')).length,1);
 }finally{sock.close();r.close();}
});

test('a binding ends ten minutes after the client\'s last flow, and the caps close what exceeds them',async()=>{
 const r=await rig({maxPerClient:1});
 try{
  await tcp(r.g.ports.http,'127.0.0.6',get('desk.app.test'));
  r.advance(9*60000);assert.equal(await tcp(r.g.ports.rtsp,'127.0.0.6','x'),'desk.app.test|tcp/48010|x');
  // one open flow holds the client's only slot: a second is closed while it lasts
  const held=net.connect({port:r.g.ports.rtsp,host:'127.0.0.1',localAddress:'127.0.0.6'});await once(held,'connect');
  held.write('y');await once(held,'data');
  assert.equal(await tcp(r.g.ports.rtsp,'127.0.0.6','x'),'');
  r.advance(11*60000);                       // a flow holds its binding however long it lasts
  held.end();await once(held,'close');
  assert.equal(await tcp(r.g.ports.rtsp,'127.0.0.6','x'),'desk.app.test|tcp/48010|x');
  r.advance(10*60000+1);assert.equal(await tcp(r.g.ports.rtsp,'127.0.0.6','x'),'');
  assert.equal(r.g.bindings.size,0);
 }finally{r.close();}
});

test('a front that refuses the tunnel closes the client; openTunnel reports the refusal',async()=>{
 const f=await front();
 try{
  const connect=async()=>{const s=net.connect(f.port,'127.0.0.1');await once(s,'connect');return s;};
  await assert.rejects(openTunnel({to:'10.9.0.2',name:'desk.app.test',proto:'tcp',port:22,connect}),/tunnel refused: HTTP\/1\.1 404/);
  const t=await openTunnel({to:'10.9.0.2',name:'desk.app.test',proto:'tcp',port:48010,connect});t.socket.destroy();
  assert.deepEqual(f.seen,['desk.app.test|tcp/48010|']);
 }finally{f.close();}
});
