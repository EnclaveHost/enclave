// Host egress (policy mode 'host', docs/design/enclave-network.md): an app's outbound traffic leaves through this host's
// own internet connection. The host operator opts in (cfg.enclaveNetwork.hostEgress), because the app's destinations see
// the operator's address. It returns the same circuit shape the managers use for a BYO tunnel (egress only):
//   {id, kind:'host', egress:'127.0.0.1:port', egressReady, ingress:false, providers, admit(), close(), 'down'}
// The entry speaks exactly what enclave-wg's SOCKS server speaks (network/wg/socks.go): SOCKS5 without authentication on
// loopback, CONNECT only, IPv4/IPv6/name; names resolve through public resolvers (never the host's LAN resolver), and every
// address is judged like network/wg/policy.go: no loopback, private, CGNAT, link-local (metadata), multicast, reserved or
// documentation ranges, no SMTP, never the host's own addresses.
import net from 'node:net';import dns from 'node:dns';
import {EventEmitter} from 'node:events';import {randomBytes} from 'node:crypto';

// two lists: a BlockList matches IPv4 addresses against IPv6 rules such as ::ffff:0:0/96
const BLOCKED4=new net.BlockList(),BLOCKED6=new net.BlockList();
for(const c of ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24',
 '192.0.2.0/24','192.88.99.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4']){
 const [a,b]=c.split('/');BLOCKED4.addSubnet(a,+b,'ipv4');
}
for(const c of ['::/128','::1/128','::ffff:0:0/96','64:ff9b::/96','64:ff9b:1::/48','100::/64','2001::/23','2001:db8::/32',
 '2002::/16','fc00::/7','fe80::/10','ff00::/8']){
 const [a,b]=c.split('/');BLOCKED6.addSubnet(a,+b,'ipv6');
}
const REP={ok:0,notAllowed:2,hostUnreach:4,refused:5,cmd:7,addr:8};
const MAX_SOCKETS=1024,HANDSHAKE_MS=20000,DIAL_MS=15000;

// IPv4-mapped IPv6 judged as the IPv4 it carries (Go: a.Unmap())
function unmap(a){const m=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);return m?m[1]:a;}
// -> null when port on address is an allowed destination, else why not
export function judgeHostDestination(address,port,{own=[],noIPv6=false}={}){
 const a=unmap(address),kind=net.isIP(a);
 if(!kind||!Number.isInteger(port)||port<1||port>65535||port===25)return 'refused';
 if(kind===6&&noIPv6)return 'refused';
 if(kind===4?BLOCKED4.check(a,'ipv4'):BLOCKED6.check(a,'ipv6'))return 'refused';
 if(own.some(o=>unmap(o)===a))return 'refused';
 return null;
}

export class HostEgress {
 // own: this host's public addresses (never a destination); resolvers: where names resolve (public, never the LAN's)
 // connect / lookup: injectable for tests (lookup(name) -> [addresses])
 constructor({authorize,own=[],resolvers=['1.1.1.1','9.9.9.9'],noIPv6=true,connect=net.connect,lookup=null,log=()=>{}}){
  if(typeof authorize!=='function')throw new Error('host egress: an admission gate is required');
  for(const r of resolvers)if(judgeHostDestination(r,53)!==null)throw new Error('host egress: resolvers must be public addresses');
  const resolver=new dns.promises.Resolver({timeout:5000,tries:2});resolver.setServers(resolvers);
  Object.assign(this,{authorize,own,noIPv6,connect,resolver,log});if(lookup)this.resolve=lookup;this.active=new Set();this.closed=false;
 }
 async resolve(name){
  const [v4,v6]=await Promise.all([this.resolver.resolve4(name).catch(()=>[]),this.noIPv6?[]:this.resolver.resolve6(name).catch(()=>[])]);
  return [...v4,...v6];
 }
 async close(){this.closed=true;await Promise.all([...this.active].map(c=>c.close('host egress stopped')));}
 async start({deploymentId}){
  if(this.closed)throw new Error('host egress stopped');
  const id=randomBytes(16).toString('hex'),sockets=new Set();let closing;
  const circuit=new EventEmitter();
  Object.assign(circuit,{id,deploymentId,kind:'host',closed:false,transport:'host',fallback:false,ingress:false,egressReady:true,address:null,
   providers:{host:{}},stats:{app:{up:0,down:0}}});
  this.active.add(circuit);
  const server=net.createServer(socket=>{
   if(circuit.closed||!this.authorize(deploymentId)||sockets.size>=MAX_SOCKETS){socket.destroy();return;}
   sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});
   void this.handle(socket,circuit,sockets).catch(()=>socket.destroy());
  });
  circuit.close=reason=>{
   if(closing)return closing;circuit.closed=true;
   closing=(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(()=>r()));this.active.delete(circuit);circuit.emit('down',reason||'closed');})();
   return closing;
  };
  // a lapsed lease or proof cuts every open connection; new ones are refused by the gate above
  circuit.admit=expiresAt=>{if(expiresAt<=Date.now())for(const s of sockets)s.destroy();};
  circuit.publishDiscovery=()=>{};
  await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
  circuit.egress='127.0.0.1:'+server.address().port;
  return circuit;
 }
 // one SOCKS5 exchange, then a splice
 async handle(c,circuit,sockets){
  c.setTimeout(HANDSHAKE_MS,()=>c.destroy());
  const rd=reader(c);
  const [ver,n]=await rd(2);if(ver!==5||!n)return c.destroy();
  const methods=await rd(n);if(!methods.includes(0)){c.end(Buffer.from([5,0xff]));return;}
  c.write(Buffer.from([5,0]));
  const [v,cmd,,atyp]=await rd(4);if(v!==5)return c.destroy();
  const reply=code=>c.write(Buffer.from([5,code,0,1,0,0,0,0,0,0]));
  if(cmd!==1){reply(REP.cmd);return c.end();}
  let host;
  if(atyp===1)host=[...await rd(4)].join('.');
  else if(atyp===4)host=ipv6(await rd(16));
  else if(atyp===3){const [l]=await rd(1);if(!l){reply(REP.addr);return c.end();}host=(await rd(l)).toString('latin1');}
  else{reply(REP.addr);return c.end();}
  const p=await rd(2),port=p.readUInt16BE(0);
  let addrs;
  if(net.isIP(host))addrs=[host];
  else{
   if(host.length>253){reply(REP.addr);return c.end();}
   addrs=await this.resolve(host).catch(()=>[]);if(!addrs.length){reply(REP.hostUnreach);return c.end();}
  }
  let code=REP.notAllowed,up=null;
  const deadline=Date.now()+DIAL_MS;
  for(const a of addrs){
   if(judgeHostDestination(a,port,{own:this.own,noIPv6:this.noIPv6})!==null)continue;
   if(Date.now()>=deadline){code=REP.hostUnreach;break;}
   up=await new Promise(res=>{
    const s=this.connect({host:unmap(a),port,timeout:deadline-Date.now()});
    const done=ok=>{s.removeAllListeners('connect');s.removeAllListeners('timeout');res(ok?s:null);if(!ok)s.destroy();};
    s.once('connect',()=>done(true));s.once('error',()=>done(false));s.once('timeout',()=>done(false));
   });
   if(up)break;code=REP.refused;
  }
  if(!up||c.destroyed){reply(code);up?.destroy();return c.end();}
  if(circuit.closed){up.destroy();return c.destroy();}
  sockets.add(up);up.once('close',()=>sockets.delete(up));
  reply(REP.ok);c.setTimeout(0);up.setTimeout(0);
  const close=()=>{c.destroy();up.destroy();};up.on('error',close);c.on('error',close);c.once('close',close);up.once('close',close);
  // anything the client sent after its request (pipelined) is already buffered in the reader
  const rest=rd.rest();if(rest.length){up.write(rest);circuit.stats.app.up+=rest.length;}
  c.on('data',b=>{circuit.stats.app.up+=b.length;});up.on('data',b=>{circuit.stats.app.down+=b.length;});
  c.pipe(up);up.pipe(c);
 }
}

function ipv6(b){const h=[];for(let i=0;i<16;i+=2)h.push(b.readUInt16BE(i).toString(16));return h.join(':');}
// exact-length reads from a socket, keeping any extra bytes for the splice
function reader(sock){
 let buf=Buffer.alloc(0),want=0,wake=null,ended=false;
 const onData=d=>{buf=Buffer.concat([buf,d]);if(wake&&buf.length>=want){const w=wake;wake=null;w();}};
 const onEnd=()=>{ended=true;if(wake){const w=wake;wake=null;w();}};
 sock.on('data',onData);sock.once('end',onEnd);sock.once('close',onEnd);
 const rd=async n=>{
  if(buf.length<n){want=n;await new Promise(r=>{wake=r;});}
  if(buf.length<n)throw new Error(ended?'client closed during the SOCKS handshake':'short read');
  const out=buf.subarray(0,n);buf=buf.subarray(n);return out;
 };
 rd.rest=()=>{sock.off('data',onData);sock.pause();const r=buf;buf=Buffer.alloc(0);return r;};
 return rd;
}
