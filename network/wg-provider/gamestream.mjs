// Public GameStream (Moonlight) ingress for desktop apps: Sunshine's six ports on this provider's public address,
// carried to the app through the port tunnel its own front serves on 443 (isolation/m4/PROTECTED-PORTS.md:
// /.well-known/enclave-tunnel/{tcp|udp}/{port}, `enclave-port/1`). The front connects only to ports the app's measured
// image declares, so this reaches nothing an internet client cannot already reach under the app's public name; pairing
// and stream encryption stay Sunshine's. Unlike the 443/80 router this ends the tunnel's TLS here (as any client of the
// app does), so this provider sees the GameStream bytes exactly as a network hop of an ordinary Sunshine would.
//
// GameStream has fixed ports and most of its flows carry no name, so one address serves many apps like this: the PC
// added in Moonlight is the app's own name, and the client's HTTP request (47989, Host) or TLS hello (47984, SNI) carries
// it. A name a peer holds BINDS the client's address to that app here; its RTSP (48010) and UDP (47998-48000) flows, and
// requests without a name, follow the binding. No name and no binding: closed or dropped. A name no peer holds, or one
// served on this box (localRoutes): never bound. Two clients behind one address that stream different apps through one
// provider share a binding (the later name wins for new flows). Opt-in: provider.json "gameStream": true.
//
// An app's name can resolve to several boxes, and a client resolves it more than once (Moonlight: its HTTPS requests
// and its stream separately), so the name may arrive at one box and the nameless flows at another. `ask(addr)` lets a
// box learn the binding from the others of its operator (-> {name, age in ms since a name last set it} | null): a
// nameless TCP flow asks first, and the most recently NAMED binding wins, here or there. UDP never asks (a stream's
// RTSP comes first and has asked). Without `ask` nothing changes.
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import {clientHelloName} from '../client-hello.mjs';
import {hostHeader} from './router.mjs';

export const GAMESTREAM_PORTS={http:47989,https:47984,rtsp:48010,udp:[47998,47999,48000]};
const MAX_FRAME=65507,PROTOCOL='enclave-port/1';

const tlsConnect=(to,name)=>new Promise((resolve,reject)=>{
 const s=tls.connect({host:to,port:443,servername:name,ALPNProtocols:['http/1.1']},()=>{s.removeListener('error',reject);s.setTimeout(0);resolve(s);});
 s.once('error',reject);s.setTimeout(10000,()=>s.destroy(Error('tunnel connect timeout')));
});

// One port tunnel to the app: TLS to the peer's tunnel address under the app's name (its public certificate must verify),
// then the upgrade. -> {socket, rest}: the upgraded connection and any frame bytes that arrived with the answer.
export async function openTunnel({to,name,proto,port,connect=tlsConnect,timeout=10000}){
 const s=await connect(to,name);
 return new Promise((resolve,reject)=>{
  let head=Buffer.alloc(0);
  const fail=e=>{s.destroy();reject(e);},closed=()=>fail(Error('tunnel closed'));
  s.setTimeout(timeout,()=>fail(Error('tunnel upgrade timeout')));s.once('error',fail);s.once('close',closed);
  const read=chunk=>{
   head=Buffer.concat([head,chunk]);const end=head.indexOf('\r\n\r\n');
   if(end<0){if(head.length>8192)fail(Error('tunnel answer too long'));return;}
   const text=head.subarray(0,end+2).toString('latin1');
   if(!/^HTTP\/1\.1 101 /.test(text)||!/\r\nupgrade:[ \t]*enclave-port\/1[ \t]*\r\n/i.test(text))return fail(Error('tunnel refused: '+text.split('\r\n')[0].slice(0,60)));
   s.removeListener('data',read);s.removeListener('error',fail);s.removeListener('close',closed);s.setTimeout(0);s.pause();
   resolve({socket:s,rest:head.subarray(end+4)});
  };
  s.on('data',read);
  s.write(`GET /.well-known/enclave-tunnel/${proto}/${port} HTTP/1.1\r\nHost: ${name}\r\nConnection: Upgrade\r\nUpgrade: ${PROTOCOL}\r\n\r\n`);
 });
}

const frame=b=>{const h=Buffer.allocUnsafe(2);h.writeUInt16BE(b.length);return b.length?Buffer.concat([h,b]):h;};
// -> a 'data' handler that calls onFrame with each whole frame's bytes (an oversized frame is a protocol error)
function deframer(onFrame,onError){
 let buf=Buffer.alloc(0);
 return chunk=>{
  buf=buf.length?Buffer.concat([buf,chunk]):chunk;
  while(buf.length>=2){const n=buf.readUInt16BE(0);if(n>MAX_FRAME)return onError();if(buf.length<2+n)break;onFrame(buf.subarray(2,2+n));buf=buf.subarray(2+n);}
 };
}

export async function createGameStream({route,host='0.0.0.0',ports=GAMESTREAM_PORTS,connect=tlsConnect,count=()=>{},log=()=>{},now=Date.now,
  bindingMs=10*60000,udpIdleMs=90000,maxFlows=4096,maxPerClient=64,maxBindings=16384,ask=null,askAgainMs=5000,askMissMs=1000,maxAsking=64}){
 // only a peer's tunnel address: a name served on this box is not an app
 const peerOf=name=>{const to=name&&route(name);return typeof to==='string'?to:null;};
 const bindings=new Map(),perClient=new Map(),open=new Set();let flows=0;
 const bound=addr=>{const b=bindings.get(addr);if(!b)return null;if(!b.flows&&now()-b.at>bindingMs){bindings.delete(addr);return null;}return b;};
 const sweep=()=>{for(const addr of [...bindings.keys()])bound(addr);};
 // `named`: when a name last set this binding, `here` or at the box it was learned from; `at` is the expiry clock
 const bind=(addr,name,named=now())=>{
  const b=bindings.get(addr);if(b?.name===name){b.at=now();if(named>=b.named){b.named=named;b.here=true;}return b;}
  if(!b&&bindings.size>=maxBindings){sweep();if(bindings.size>=maxBindings)return null;}
  const fresh={name,at:now(),named,here:true,flows:0};bindings.set(addr,fresh);return fresh;
 };
 // -> the binding a nameless TCP flow of this client follows, after asking the other boxes. Not asked: a client that
 // named an app HERE within askAgainMs, one asked within askAgainMs (askMissMs when nothing was bound after it), and
 // anything beyond maxAsking clients at a time; then, and on any failure, what is known here decides.
 const asking=new Map(),quiet=new Map();let learned=0;
 async function settle(addr){
  const own=bound(addr);
  if(!ask||(own&&own.here&&now()-own.named<askAgainMs)||quiet.get(addr)>now())return own;
  let p=asking.get(addr);
  if(!p){
   if(asking.size>=maxAsking||quiet.size>=maxBindings)return own;
   p=(async()=>{
    await null;   // (so that `asking` holds this before it can end)
    let heard=null;try{heard=await ask(addr);}catch{}
    try{
     if(heard&&typeof heard.name==='string'&&Number.isSafeInteger(heard.age)&&heard.age>=0&&peerOf(heard.name)){
      const mine=bound(addr),named=now()-heard.age;
      if(mine?.name===heard.name){if(named>mine.named){mine.named=named;mine.here=false;}}
      else if(!mine||named>mine.named){const b=bind(addr,heard.name,named);if(b){b.here=false;learned++;}}
     }
    }catch{}
    asking.delete(addr);quiet.set(addr,now()+(bound(addr)?askAgainMs:askMissMs));
   })();
   asking.set(addr,p);
  }
  await p;return bound(addr);
 }
 // a flow holds its client's binding (it does not expire under a stream) and counts against the per-client and total caps
 const admit=addr=>{if(flows>=maxFlows||(perClient.get(addr)||0)>=maxPerClient)return false;flows++;perClient.set(addr,(perClient.get(addr)||0)+1);return true;};
 const hold=(addr,b)=>{b.flows++;let done=false;return()=>{if(done)return;done=true;b.flows--;b.at=now();flows--;const n=perClient.get(addr)-1;if(n>0)perClient.set(addr,n);else perClient.delete(addr);};};

 async function tcpFlow(client,b,port,head){
  const addr=client.remoteAddress,to=peerOf(b.name);
  if(!to||!admit(addr))return client.destroy();
  const release=hold(addr,b);client.once('close',release);
  let t;try{t=await openTunnel({to,name:b.name,proto:'tcp',port,connect});}catch(e){log(`gamestream ${b.name} tcp/${port}: ${e.message}`);return client.destroy();}
  const up=t.socket;if(client.destroyed)return up.destroy();
  open.add(up);up.once('close',()=>open.delete(up));
  const close=()=>{client.destroy();up.destroy();};
  client.on('error',close);up.on('error',close);client.once('close',close);up.once('close',close);client.setTimeout(0);
  // client -> app: frames; the client's FIN is a zero-length frame inside TLS (the tunnel's half-close)
  const send=bytes=>{let ok=true;for(let i=0;i<bytes.length;i+=MAX_FRAME)ok=up.write(frame(bytes.subarray(i,i+MAX_FRAME)));count(to,bytes.length,0);if(!ok){client.pause();up.once('drain',()=>client.resume());}};
  const fin=()=>{if(!up.destroyed)up.write(frame(Buffer.alloc(0)));};
  client.on('data',send);
  const receive=deframer(payload=>{
   if(!payload.length)return client.end();
   count(to,0,payload.length);if(!client.write(payload)){up.pause();client.once('drain',()=>up.resume());}
  },close);
  up.on('data',receive);if(t.rest.length)receive(t.rest);
  if(head.length)send(head);
  // a FIN that came with the first bytes has already been reported ('end' fires on a paused socket once it is drained)
  if(client.readableEnded)fin();else client.once('end',fin);
  up.resume();client.resume();
 }

 const sockets=new Set();
 // 47989 (HTTP, named by Host) and 47984 (TLS, named by SNI): a name a peer holds binds the client; anything else (an
 // address in Host, no SNI, bytes that are neither) follows the client's binding
 const named=isTls=>net.createServer({allowHalfOpen:true},socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  socket.setTimeout(10000,()=>socket.destroy());
  let head=Buffer.alloc(0),started=false;
  socket.once('end',()=>{if(!started)socket.destroy();});   // a connect probe: no bytes, nothing opened
  const read=chunk=>{
   head=Buffer.concat([head,chunk]);if(head.length>65536)return socket.destroy();
   const name=isTls?clientHelloName(head):hostHeader(head);if(name===null)return;
   socket.removeListener('data',read);socket.pause();started=true;
   const go=b=>{if(!b||socket.destroyed)return socket.destroy();void tcpFlow(socket,b,isTls?GAMESTREAM_PORTS.https:GAMESTREAM_PORTS.http,head);};
   if(name&&peerOf(name))go(bind(socket.remoteAddress,name));else void settle(socket.remoteAddress).then(go);
  };
  socket.on('data',read);
 });
 // 48010 (RTSP): no name in it; the client's binding decides
 const rtsp=net.createServer({allowHalfOpen:true},socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  socket.pause();
  void settle(socket.remoteAddress).then(b=>{if(!b||socket.destroyed)return socket.destroy();void tcpFlow(socket,b,GAMESTREAM_PORTS.rtsp,Buffer.alloc(0));});
 });

 // UDP: one tunnel per client address and port (an association), each datagram one frame, boundaries kept
 const udp=(_,i)=>{
  const port=GAMESTREAM_PORTS.udp[i];   // the app's port, whatever this side listens on
  const sock=dgram.createSocket('udp4'),assoc=new Map();
  sock.on('error',e=>log(`gamestream udp/${port}: ${e.message}`));
  sock.on('message',(msg,r)=>{
   const key=r.address+':'+r.port;let a=assoc.get(key);
   if(!a){
    const b=bound(r.address),to=b&&peerOf(b.name);if(!to||!admit(r.address))return;
    const release=hold(r.address,b);
    a={up:null,queue:[],at:now(),end(){if(assoc.get(key)===a)assoc.delete(key);release();a.up?.destroy();a.queue=null;}};assoc.set(key,a);
    openTunnel({to,name:b.name,proto:'udp',port,connect}).then(t=>{
     if(!a.queue)return t.socket.destroy();
     const up=a.up=t.socket;open.add(up);up.once('close',()=>{open.delete(up);a.end();});up.on('error',()=>up.destroy());
     const receive=deframer(payload=>{a.at=now();count(to,0,payload.length);sock.send(payload,r.port,r.address,()=>{});},()=>up.destroy());
     up.on('data',receive);if(t.rest.length)receive(t.rest);
     for(const m of a.queue)up.write(frame(m));a.queue=[];up.resume();
    },e=>{log(`gamestream ${b.name} udp/${port}: ${e.message}`);a.end();});
    a.to=to;
   }
   a.at=now();count(a.to,msg.length,0);
   if(!a.up){if(a.queue.length<64)a.queue.push(msg);}
   else if(a.up.writableLength<1<<20)a.up.write(frame(msg));   // behind a stalled tunnel a datagram is lost, not queued without bound
  });
  return {sock,assoc};
 };

 const listenTcp=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolve(server.address().port));});
 const http=named(false),https=named(true),udps=ports.udp.map(udp);
 const bound_={http:await listenTcp(http,ports.http),https:await listenTcp(https,ports.https),rtsp:await listenTcp(rtsp,ports.rtsp),udp:[]};
 for(let i=0;i<udps.length;i++)bound_.udp.push(await new Promise((resolve,reject)=>{udps[i].sock.once('error',reject);udps[i].sock.bind(ports.udp[i],host,()=>resolve(udps[i].sock.address().port));}));
 const timer=setInterval(()=>{sweep();for(const [addr,until] of quiet)if(until<=now())quiet.delete(addr);for(const u of udps)for(const a of [...u.assoc.values()])if(now()-a.at>udpIdleMs)a.end();},15000);timer.unref?.();
 return {ports:bound_,bindings,stats:()=>({flows,bindings:bindings.size,learned}),
  // what this box tells another that asks: the live binding of a client and how long ago a name set it
  bindingOf(addr){const b=bound(addr);return b?{name:b.name,age:Math.max(0,now()-b.named)}:null;},
  close(){clearInterval(timer);for(const s of [http,https,rtsp])s.close();for(const u of udps){for(const a of [...u.assoc.values()])a.end();u.sock.close();}for(const s of [...sockets,...open])s.destroy();}};
}
