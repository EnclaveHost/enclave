// The GameStream ingress (gamestream.mjs) as a service of its own, beside a provider it does not change. It listens on
// Sunshine's six ports on this box's public address and carries each flow through the app's 443 port tunnel BY WAY OF
// THE PROVIDER'S OWN 443 ROUTER on this box: TLS to `router` (127.0.0.1) under the app's name, which that router
// forwards to the peer holding the name, exactly as it forwards any internet client. So this holds no key, reads no
// provider state and reaches only what port 443 of this box already serves; the app's public certificate must verify.
//
// It cannot ask the provider which names a peer holds, so the names it will bind are those of its configured zones
// (one label under a zone: <id>.app.<zone>). A name under a zone that no peer holds still binds the client that sent
// it; that client's flows then fail at the router (closed), and nobody else's are touched. Bytes are metered by the
// router, as routed 443 traffic. For a provider that runs main's own release, `"gameStream": true` in provider.json
// is the tighter form (it binds only names a peer holds).
//
// SIBLINGS. An app's name can resolve to several boxes, and a client resolves it more than once, so it may name the app
// to one box and send its nameless flows (RTSP, then UDP) to another. `siblings` lists the other boxes OF THE SAME
// OPERATOR that serve the zones; a box asks them which app a client named before it carries that client's nameless TCP
// flow (gamestream.mjs, `ask`). One TCP exchange on `siblingPort`: `enclave-gs-binding/1 <client address>` answered
// `<name> <ms since it was named>` or `-`. A box answers only connections that come FROM a sibling's address (the
// installer also opens the port to those addresses alone), tells nothing but that name, and takes a name only if it is
// under its own zones. So a sibling, or someone on the path between two siblings, can at most point a client's nameless
// flows at another app under the zones, where Sunshine does not know that client: its stream fails, nothing is exposed.
// A sibling that does not answer within a second is left out for half a minute; without an answer the box decides alone.
import net from 'node:net';
import {createGameStream,GAMESTREAM_PORTS} from './gamestream.mjs';

const IPV4=/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const LABEL='[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const ZONE=new RegExp(`^${LABEL}(?:\\.${LABEL})+$`),ONE=new RegExp(`^${LABEL}$`);
const CAPS={maxFlows:[1,4096,256],maxPerClient:[1,64,32],maxBindings:[1,16384,4096]};
export const SIBLING_PORT=47997;
const ASK='enclave-gs-binding/1',MAX_AGE=999999999;

// -> the checked configuration with defaults filled in; throws on anything it does not know
export function parseGatewayConfig(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('configuration must be an object');
 for(const k of Object.keys(raw))if(!['zones','router','host','siblings','siblingPort',...Object.keys(CAPS)].includes(k))throw Error(`unknown field ${k}`);
 const {zones,router='127.0.0.1',host,siblings=[],siblingPort=SIBLING_PORT}=raw;
 if(!Array.isArray(zones)||!zones.length||zones.length>8||zones.some(z=>typeof z!=='string'||z.length>200||!ZONE.test(z)))throw Error('zones must be 1-8 lowercase DNS names');
 if(typeof router!=='string'||!IPV4.test(router))throw Error('router must be an IPv4 address (the provider\'s 443 router, 127.0.0.1)');
 if(typeof host!=='string'||!IPV4.test(host))throw Error('host must be the IPv4 address to listen on');
 const caps={};
 for(const [k,[min,max,usual]] of Object.entries(CAPS)){const v=raw[k]??usual;if(!Number.isInteger(v)||v<min||v>max)throw Error(`${k} must be an integer from ${min} to ${max}`);caps[k]=v;}
 if(!Array.isArray(siblings)||siblings.length>8||siblings.some(a=>typeof a!=='string'||!IPV4.test(a)||a==='0.0.0.0'))throw Error('siblings must be at most 8 IPv4 addresses');
 if(!Number.isInteger(siblingPort)||siblingPort<1024||siblingPort>65535||[...Object.values(GAMESTREAM_PORTS)].flat().includes(siblingPort))throw Error('siblingPort must be a port from 1024 to 65535 that Sunshine does not use');
 // one list can serve every box: a box's own address in it is left out
 return {zones:[...new Set(zones)],router,host,...caps,siblings:[...new Set(siblings)].filter(a=>a!==host),siblingPort};
}

// -> route(name): `router` for one label under a zone, null for everything else (an address, a deeper or foreign name)
export function zoneRoute(zones,router){
 return name=>{
  if(typeof name!=='string'||name.length>253)return null;
  for(const zone of zones)if(name.endsWith('.'+zone)&&ONE.test(name.slice(0,-zone.length-1)))return router;
  return null;
 };
}

// at most `burst` lines a minute: a client that names apps nobody holds cannot fill the journal
export function limitedLog(write,{burst=30,now=Date.now}={}){
 let start=now(),n=0,dropped=0;
 return line=>{
  if(now()-start>=60000){if(dropped)write(`(${dropped} more lines not logged in the last minute)`);start=now();n=0;dropped=0;}
  if(n<burst){n++;write(line);}else dropped++;
 };
}

// The sibling exchange of one box: a listener that answers its siblings from `bindingOf`, and ask(addr) -> the most
// recently named answer of the siblings ({name, age} | null).
export async function startSiblings({host,siblings,port=SIBLING_PORT,bindingOf,now=Date.now,askMs=1000,skipMs=30000,maxAnswering=256}){
 const sockets=new Set();
 const server=net.createServer(socket=>{
  socket.on('error',()=>{});
  if(!siblings.includes(socket.remoteAddress))return socket.destroy();
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
  socket.setTimeout(2000,()=>socket.destroy());
  let line='';
  const read=chunk=>{
   line+=chunk.toString('latin1');const end=line.indexOf('\n');
   if(end<0){if(line.length>64)socket.destroy();return;}
   socket.removeListener('data',read);
   const [word,addr,...more]=line.slice(0,end).split(' ');
   if(word!==ASK||more.length||!IPV4.test(addr||''))return socket.destroy();
   const b=bindingOf(addr);socket.end(b?`${b.name} ${Math.min(b.age,MAX_AGE)}\n`:'-\n');
  };
  socket.on('data',read);
 });
 server.maxConnections=maxAnswering;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
 const skip=new Map(),asks=new Set();
 // -> {name, age} | null; a sibling that fails or stays silent is not asked again for skipMs
 const askOne=(sibling,addr)=>new Promise(resolve=>{
  let reply='',done=false;
  const socket=net.connect({host:sibling,port:server.address().port,localAddress:host});asks.add(socket);
  const finish=(answer,failed)=>{if(done)return;done=true;clearTimeout(timer);asks.delete(socket);socket.destroy();if(failed)skip.set(sibling,now()+skipMs);resolve(answer);};
  const timer=setTimeout(()=>finish(null,true),askMs);
  socket.on('error',()=>finish(null,true));socket.once('close',()=>finish(null,true));
  socket.once('connect',()=>socket.write(`${ASK} ${addr}\n`));
  socket.on('data',chunk=>{
   reply+=chunk.toString('latin1');const end=reply.indexOf('\n');
   if(end<0){if(reply.length>300)finish(null,true);return;}
   const text=reply.slice(0,end);if(text==='-')return finish(null,false);
   const m=/^([a-z0-9.-]{1,253}) (\d{1,9})$/.exec(text);finish(m?{name:m[1],age:+m[2]}:null,!m);
  });
 });
 return {port:server.address().port,
  async ask(addr){
   if(typeof addr!=='string'||!IPV4.test(addr))return null;
   const answers=await Promise.all(siblings.filter(s=>!(skip.get(s)>now())).map(s=>askOne(s,addr)));
   return answers.filter(Boolean).sort((a,b)=>a.age-b.age)[0]||null;
  },
  close(){server.close();for(const s of [...sockets,...asks])s.destroy();}};
}

export async function startGateway(cfg,{log=()=>{},ports=GAMESTREAM_PORTS,connect,siblingPort=cfg.siblingPort}={}){
 const {zones,router,host,maxFlows,maxPerClient,maxBindings,siblings=[]}=cfg;
 let g=null;
 const sib=siblings.length?await startSiblings({host,siblings,port:siblingPort,bindingOf:addr=>g?g.bindingOf(addr):null}):null;
 try{g=await createGameStream({route:zoneRoute(zones,router),host,ports,log,maxFlows,maxPerClient,maxBindings,...(connect?{connect}:{}),...(sib?{ask:sib.ask}:{})});}
 catch(e){sib?.close();throw e;}
 log(`gamestream gateway: ${host} TCP ${g.ports.https}, ${g.ports.http}, ${g.ports.rtsp} and UDP ${g.ports.udp.join(', ')} for *.${zones.join(', *.')} through ${router}:443`);
 if(sib)log(`gamestream gateway: asks ${siblings.length} sibling(s) on TCP ${sib.port}, and answers them`);
 let closed=false;
 return {...g,siblingPort:sib?sib.port:null,close(){if(closed)return;closed=true;sib?.close();g.close();}};
}
