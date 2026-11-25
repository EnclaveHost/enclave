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
//
// The UDP ports carry live video, audio and input, and a tunnel is TCP: on a path that loses packets a plain tunnel
// queues them and the picture falls behind without bound. So a UDP association asks the app's front for a FLOW
// (port-flow.mjs; isolation/m2/tunnel/tunnel_flow.go): `flowLanes` connections per port instead of one, each end
// reporting what it received, the front dropping what would be late and sending again what a stalled connection
// holds, this end delivering in order. A front that does not answer the flow header gets the plain tunnel.
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import {randomBytes} from 'node:crypto';
import {FLOW_HEADER,flowReport,flowReceiver,lanePicker,flowDeframer,rtpLag} from './port-flow.mjs';
import {clientHelloName} from '../client-hello.mjs';
import {hostHeader} from './router.mjs';

export const GAMESTREAM_PORTS={http:47989,https:47984,rtsp:48010,udp:[47998,47999,48000]};
const MAX_FRAME=65507,PROTOCOL='enclave-port/1';

const tlsConnect=(to,name)=>new Promise((resolve,reject)=>{
 // no Nagle: an input event or a report is a small write that must not wait for the previous one's acknowledgment
 const s=tls.connect({host:to,port:443,servername:name,ALPNProtocols:['http/1.1']},()=>{s.removeListener('error',reject);s.setTimeout(0);s.setNoDelay(true);resolve(s);});
 s.once('error',reject);s.setTimeout(10000,()=>s.destroy(Error('tunnel connect timeout')));
});

// One port tunnel to the app: TLS to the peer's tunnel address under the app's name (its public certificate must verify),
// then the upgrade. -> {socket, rest, flow}: the upgraded connection, any frame bytes that arrived with the answer, and
// whether the front took the flow asked for with `flow` (32 hex digits; UDP only).
export async function openTunnel({to,name,proto,port,connect=tlsConnect,timeout=10000,flow=null}){
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
   resolve({socket:s,rest:head.subarray(end+4),flow:!!flow&&/\r\nenclave-port-flow:[ \t]*1[ \t]*\r\n/i.test(text)});
  };
  s.on('data',read);
  s.write(`GET /.well-known/enclave-tunnel/${proto}/${port} HTTP/1.1\r\nHost: ${name}\r\nConnection: Upgrade\r\nUpgrade: ${PROTOCOL}\r\n${flow?`${FLOW_HEADER}: ${flow}\r\n`:''}\r\n`);
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
  bindingMs=10*60000,udpIdleMs=90000,supersedeMs=5000,renewSilentMs=0,maxFlows=4096,maxPerClient=64,maxBindings=16384,ask=null,askAgainMs=5000,askMissMs=1000,maxAsking=64,
  // connections per UDP port's flow, in the order of ports.udp (video, control, audio); null: plain tunnels only
  flowLanes=[16,4,4],
  // how long a datagram waits here for the ones before it: what the front says a second copy takes plus a margin, and
  // never less than reorderMinMs. Measured on the KVM Box's path (2026-11-15): the whole path is silent for 120-470 ms
  // a few times a minute, and with 70 ms the datagrams of the lanes that came back first were handed on ahead of the
  // rest, which Moonlight takes for loss (frames dropped, a key frame asked for). Waiting out such a hold costs a
  // short freeze and no loss.
  reorderMs=250,reorderMinMs=250,renewMs=250,statsMs=10000,silenceMs=120,randomId=()=>randomBytes(16).toString('hex')}){
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

 // UDP: one association per client address and port, each datagram one frame, boundaries kept. With a front that
 // takes a flow the association is `flowLanes` connections; otherwise one plain tunnel.
 const flowStats={flows:0,plain:0,delivered:0,duplicates:0,skipped:0,late:0,rebuilt:0,dropped:0,renewed:0};
 const udp=(_,i)=>{
  const port=GAMESTREAM_PORTS.udp[i];   // the app's port, whatever this side listens on
  const want=Array.isArray(flowLanes)?Math.max(0,Math.min(16,flowLanes[i]|0)):0;
  const sock=dgram.createSocket('udp4'),assoc=new Map();
  sock.on('error',e=>log(`gamestream udp/${port}: ${e.message}`));
  sock.on('message',(msg,r)=>{
   const key=r.address+':'+r.port;let a=assoc.get(key);
   if(!a){
    const b=bound(r.address),to=b&&peerOf(b.name);if(!to)return;
    // A client that starts its stream again comes from a new port, and its last association would hold its lanes
    // until `udpIdleMs` (the app goes on sending for a while): the front counts those against the port's limit, and
    // the third start within that time got one lane of sixteen (2026-11-16). An association of the same client and
    // app that the client has not written to for `supersedeMs` ends when a new one starts (a live stream's client
    // writes at least twice a second on each port).
    for(const o of [...assoc.values()])if(o.client===r.address&&o.name===b.name&&now()-o.fromClient>supersedeMs)o.end();
    if(!admit(r.address))return;
    const release=hold(r.address,b),id=want?randomId():null;
    const toClient=payload=>{a.at=now();a.answered=true;a.lag?.note(payload);count(to,0,payload.length);sock.send(payload,r.port,r.address,()=>{});};
    // how far behind the video and the audio leave this box (the control port's datagrams are not RTP)
    a={up:null,flow:null,queue:[],at:now(),since:now(),client:r.address,fromClient:now(),to,heardAt:0,silence:0,gaps:[],lag:i===0?rtpLag({by:'none',now}):i===2?rtpLag({by:'sequence',now}):null,name:b.name,port,
     end(){
      if(!a.queue)return;a.say();a.queue=null;if(assoc.get(key)===a)assoc.delete(key);release();a.up?.destroy();
      if(a.flow){const st=a.flow.rx.stats();flowStats.delivered+=st.delivered;flowStats.duplicates+=st.duplicates;flowStats.skipped+=st.skipped;flowStats.late+=st.late;flowStats.rebuilt+=st.rebuilt;flowStats.dropped+=a.flow.dropped;
       // one line per association that carried something: what a stream's video, control and audio each met on the path
       if(st.delivered)log(`gamestream ${b.name} udp/${port} flow ended after ${Math.round((now()-a.since)/1000)} s: delivered ${st.delivered}, of them rebuilt from parity ${st.rebuilt}, late ${st.late}; passed over ${st.skipped}, second copies ${st.duplicates}, lanes opened ${a.flow.opened}, to the app dropped ${a.flow.dropped}`);
       a.flow.rx.close();for(const l of a.flow.lanes)l.up.destroy();}
     },
     // client -> app: behind a stalled tunnel a datagram is lost, not queued without bound
     send(m){
      if(!a.flow){if(a.up.writableLength<1<<20)a.up.write(frame(m));return;}
      // the client's datagrams are few and each matters (input): the least late lane, however late
      const n=a.flow.pick.pick({any:true}),l=n<0?null:a.flow.lanes[n];
      if(!l||l.up.destroyed||l.up.writableLength>=1<<20){a.flow.dropped++;return;}
      l.up.write(frame(m));a.flow.pick.sent(n);
     },
     // each lane tells the front what it has received (also what keeps a quiet lane open)
     tell(){if(a.flow)for(const l of a.flow.lanes)if(!l.up.destroyed){l.reported=l.received;l.up.write(flowReport(l.received));}},
     // one line every `statsMs` while datagrams flow: how late they left, and what the flow met since the last line
     said:null,
     say(){
      const g=a.lag?.take(),st=a.flow?a.flow.rx.stats({reset:true}):null;if(!g||!g.packets)return;
      const d=st?{delivered:st.delivered-(a.said?.delivered||0),rebuilt:st.rebuilt-(a.said?.rebuilt||0),over:st.skipped-(a.said?.skipped||0),late:st.late-(a.said?.late||0),copies:st.duplicates-(a.said?.duplicates||0),parity:st.parity-(a.said?.parity||0)}:null;a.said=st;
      const quiet=Math.round(a.silence)+' ms'+(a.gaps.length?` (${a.gaps.join(', ')})`:'');a.silence=0;a.gaps=[];
      log(`gamestream ${a.name} udp/${a.port} ${Math.round((now()-a.since)/1000)} s: ${g.packets} packets, ${g.lost} missing; late by ${g.p50??'?'} ms at the median, ${g.p95??'?'} at the 95th, ${g.p99??'?'} at the 99th, ${g.max??'?'} at most`
       +(d?`; rebuilt ${d.rebuilt}, passed over ${d.over}, late copies ${d.late}, second copies ${d.copies}, parity frames ${d.parity}, longest wait for a missing one ${Math.round(st.longestWaitMs)} ms of ${st.reorderMs}, longest silence of all lanes ${quiet}, lanes open ${a.flow.lanes.filter(l=>!l.up.destroyed).length} of ${a.flow.opened} (frames per lane ${a.flow.lanes.map(l=>{const n=l.received-(l.saidReceived||0);l.saidReceived=l.received;return n;}).join(' ')})`:'; plain tunnel'));
     },
    };
    assoc.set(key,a);
    // renewSilentMs (opt-in): an association the app has not answered this soon is ended, and the client's next datagram
    // opens a new one. A Moonlight pings a UDP port before Sunshine opens it when the RTSP handshake is slow (a far path):
    // an association made then never recovers, and Sunshine ends the stream when the audio ping never arrives.
    if(renewSilentMs){const t=setTimeout(()=>{if(a.queue&&!a.answered){log(`gamestream ${b.name} udp/${port}: no answer in ${renewSilentMs} ms; the next datagram opens a new association`);a.end();}},renewSilentMs);t.unref?.();}
    // the longest time no lane brought anything (while the stream ran): a hold of the whole path, not of one connection
    const heard=()=>{const t=now();if(a.heardAt){const g=t-a.heardAt;if(g>a.silence)a.silence=g;if(g>=silenceMs&&a.gaps.length<6)a.gaps.push(`${Math.round(g)} ms to ${new Date(t).toISOString().slice(11,23)}`);}a.heardAt=t;};
    const lane=t=>{
     const up=t.socket,l={up,received:0,reported:0,due:false,n:a.flow.pick.add()};a.flow.lanes[l.n]=l;a.flow.opened++;   // (a closed lane's place is used again)
     open.add(up);up.on('error',()=>up.destroy());
     // a lane that ends (the front closes one that stalls) is replaced while the association lives: at most one
     // replacement on its way at a time, and not more often than every `renewMs`
     up.once('close',()=>{
      open.delete(up);if(a.flow?.lanes[l.n]===l)a.flow.pick.remove(l.n);if(!a.queue)return;
      if(a.flow.lanes.every(x=>x.up.destroyed)&&!a.flow.opening)return a.end();
      renew();
     });
     const tell=()=>{l.due=false;if(!up.destroyed&&l.reported!==l.received){l.reported=l.received;up.write(flowReport(l.received));}};
     const receive=flowDeframer({
      onData(seq,payload){l.received++;heard();if(!l.due){l.due=true;setImmediate(tell);}a.flow.rx.push(seq,payload);},
      onReport(n){if(!a.flow.pick.report(l.n,n))up.destroy();},
      onRepair(ms){a.flow.rx.repair(ms);},
      onParity(first,count,xor){heard();a.flow.rx.parity(first,count,xor);},
      onError(){up.destroy();}});
     up.on('data',receive);if(t.rest.length)receive(t.rest);up.resume();
    };
    const openOne=()=>openTunnel({to,name:b.name,proto:'udp',port,connect,flow:id});
    const renew=()=>{
     const f=a.flow;if(!a.queue||!f||f.opening||f.lanes.filter(x=>!x.up.destroyed).length>=want)return;
     const wait=Math.max(0,f.renewedAt+renewMs-now());f.opening=true;
     const t=setTimeout(()=>{
      if(!a.queue){f.opening=false;return;}
      f.renewedAt=now();flowStats.renewed++;
      openOne().then(x=>{f.opening=false;if(!a.queue||!x.flow)return x.socket.destroy();lane(x);renew();},
       ()=>{f.opening=false;if(a.queue&&f.lanes.every(x=>x.up.destroyed))a.end();else renew();});
     },wait);t.unref?.();
    };
    // a front that refuses the request with the flow header is asked again without it
    (id?openOne().catch(e=>{if(!/^tunnel refused/.test(e.message))throw e;return openTunnel({to,name:b.name,proto:'udp',port,connect});}):openOne()).then(t=>{
     if(!a.queue)return t.socket.destroy();
     if(t.flow){
      flowStats.flows++;
      a.flow={rx:flowReceiver({deliver:toClient,reorderMs,reorderMinMs,now}),pick:lanePicker({now}),lanes:[],dropped:0,opened:0,opening:false,renewedAt:0};lane(t);
      for(let k=1;k<want;k++)openOne().then(x=>{if(!a.queue||!x.flow)return x.socket.destroy();lane(x);},e=>log(`gamestream ${b.name} udp/${port} lane: ${e.message}`));
     }else{
      flowStats.plain++;
      const up=a.up=t.socket;open.add(up);up.once('close',()=>{open.delete(up);a.end();});up.on('error',()=>up.destroy());
      const receive=deframer(toClient,()=>up.destroy());
      up.on('data',receive);if(t.rest.length)receive(t.rest);up.resume();
     }
     const waiting=a.queue;a.queue=[];for(const m of waiting)a.send(m);
    },e=>{log(`gamestream ${b.name} udp/${port}: ${e.message}`);a.end();});
   }
   a.at=a.fromClient=now();count(a.to,msg.length,0);
   if(!a.up&&!a.flow){if(a.queue.length<64)a.queue.push(msg);}
   else a.send(msg);
  });
  return {sock,assoc};
 };

 const listenTcp=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolve(server.address().port));});
 const http=named(false),https=named(true),udps=ports.udp.map(udp);
 const bound_={http:await listenTcp(http,ports.http),https:await listenTcp(https,ports.https),rtsp:await listenTcp(rtsp,ports.rtsp),udp:[]};
 for(let i=0;i<udps.length;i++)bound_.udp.push(await new Promise((resolve,reject)=>{udps[i].sock.once('error',reject);udps[i].sock.bind(ports.udp[i],host,()=>resolve(udps[i].sock.address().port));}));
 const stats=statsMs>0?setInterval(()=>{for(const u of udps)for(const a of u.assoc.values())a.say();},statsMs):null;stats?.unref?.();
 const timer=setInterval(()=>{sweep();for(const [addr,until] of quiet)if(until<=now())quiet.delete(addr);for(const u of udps)for(const a of [...u.assoc.values()]){if(now()-a.at>udpIdleMs)a.end();else a.tell();}},15000);timer.unref?.();
 return {ports:bound_,bindings,stats:()=>({flows,bindings:bindings.size,learned,udp:{...flowStats}}),
  // what this box tells another that asks: the live binding of a client and how long ago a name set it
  bindingOf(addr){const b=bound(addr);return b?{name:b.name,age:Math.max(0,now()-b.named)}:null;},
  close(){clearInterval(timer);if(stats)clearInterval(stats);for(const s of [http,https,rtsp])s.close();for(const u of udps){for(const a of [...u.assoc.values()])a.end();u.sock.close();}for(const s of [...sockets,...open])s.destroy();}};
}
