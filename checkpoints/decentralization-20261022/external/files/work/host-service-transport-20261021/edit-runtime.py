p='network/wg-circuit-runtime.mjs'; s=open(p).read()
def rep(old,new):
    global s
    assert s.count(old)==1,(old,s.count(old)); s=s.replace(old,new)
rep("""export const RENEW_MS=4*60000;""","""export const RENEW_MS=4*60000;
const sameNames=(a,b)=>Array.isArray(a)&&a.length===b.length&&[...a].sort().join('\\n')===[...b].sort().join('\\n');
const loopPort=v=>Number.isInteger(v)&&v>=1&&v<=65535;
// a host-service circuit's routing (host-service-transport.mjs): {names:{name:{http,tls|null}}, granted:[every derived
// name the exit must grant], dns:{tcp,udp}|null} - loopback role ports only
function serviceSpec(s){
 if(!s||typeof s!=='object'||!s.names||typeof s.names!=='object'||!Array.isArray(s.granted)||!s.granted.length)throw new Error('host-service circuit: names and the granted set required');
 for(const t of Object.values(s.names))if(!loopPort(t?.http)||(t.tls!==null&&t.tls!==undefined&&!loopPort(t.tls)))throw new Error('host-service circuit: role ports must be ports');
 if(s.dns&&(!(s.dns.tcp===null||loopPort(s.dns.tcp))||!(s.dns.udp===null||loopPort(s.dns.udp))))throw new Error('host-service circuit: dns ports must be ports');
 return s;
}""")
rep(""" constructor({directory,wgBinary,nodeBinary,workerModule,firewallBinary,grants,authorize,forward,platform=process.platform==='win32'?'windows':'plain',renewMs=RENEW_MS,resolvers=['1.1.1.1','9.9.9.9'],paceMbps=0,log=()=>{}}){
  if([directory,wgBinary,nodeBinary,workerModule].some(v=>typeof v!=='string'||!path.isAbsolute(v))||(platform==='windows'&&!path.isAbsolute(firewallBinary||'')))throw new Error('explicit Enclave-network runtime paths required');""",""" // serviceWorkerModule: the host-service ingress worker (host-service-ingress.mjs; bundled on Windows), only for start({service})
 constructor({directory,wgBinary,nodeBinary,workerModule,serviceWorkerModule=null,firewallBinary,grants,authorize,forward,platform=process.platform==='win32'?'windows':'plain',renewMs=RENEW_MS,resolvers=['1.1.1.1','9.9.9.9'],paceMbps=0,log=()=>{}}){
  if([directory,wgBinary,nodeBinary,workerModule].some(v=>typeof v!=='string'||!path.isAbsolute(v))||(platform==='windows'&&!path.isAbsolute(firewallBinary||'')))throw new Error('explicit Enclave-network runtime paths required');
  if(serviceWorkerModule!==null&&(typeof serviceWorkerModule!=='string'||!path.isAbsolute(serviceWorkerModule)))throw new Error('explicit host-service worker path required');""")
rep("""  Object.assign(this,{directory,wgBinary,nodeBinary,workerModule,firewallBinary,grants,authorize,forward,platform,renewMs,resolvers,paceMbps,log});this.active=new Set();this.closed=false;""","""  Object.assign(this,{directory,wgBinary,nodeBinary,workerModule,serviceWorkerModule,firewallBinary,grants,authorize,forward,platform,renewMs,resolvers,paceMbps,log});this.active=new Set();this.closed=false;""")
rep(""" // exitRole 'control' + gate: the host's own control circuit (no app; egress only, admitted by `gate`, not by an app's lease)
 async start({deploymentId,names,kind='network',guard,exit,byo,ingress=false,egress=false,fallback=false,exitRole='exit',gate}){
  const authorize=gate||this.authorize;
  if(this.closed)throw new Error('runtime stopped');""",""" // exitRole 'control' + gate: the host's own control circuit (no app; egress only, admitted by `gate`, not by an app's lease)
 // exitRole 'service' + service: the host's own public service roles (host-service-transport.mjs): ingress only, through
 // the host-service worker to loopback role ports - no broker, no app forwarder; the exit must grant exactly service.granted
 async start({deploymentId,names,kind='network',guard,exit,byo,ingress=false,egress=false,fallback=false,exitRole='exit',gate,service=null}){
  const authorize=gate||this.authorize;
  if(this.closed)throw new Error('runtime stopped');
  if(service&&(kind!=='network'||!ingress||egress||exitRole!=='service'||!this.serviceWorkerModule))throw new Error('a host-service circuit is a network circuit with ingress only, exit role service and the host-service worker');
  if(exitRole==='service'&&!service)throw new Error('exit role service needs the host-service routing');
  if(service)serviceSpec(service);""")
rep("""   if(this.platform==='windows')await Promise.all([[this.wgBinary,files.wg],[this.nodeBinary,files.node],[this.workerModule,path.join(dir,'worker.mjs')]].map(([a,b])=>fs.copyFile(a,b)));
   const workerModule=this.platform==='windows'?path.join(dir,'worker.mjs'):this.workerModule;""","""   const sourceWorker=service?this.serviceWorkerModule:this.workerModule;
   if(this.platform==='windows')await Promise.all([[this.wgBinary,files.wg],[this.nodeBinary,files.node],[sourceWorker,path.join(dir,'worker.mjs')]].map(([a,b])=>fs.copyFile(a,b)));
   const workerModule=this.platform==='windows'?path.join(dir,'worker.mjs'):sourceWorker;""")
rep("""   if(ingress){
    const token=randomBytes(32).toString('hex');""","""   // a host-service circuit: the worker gets its name table and two listen ports; it reaches only the role ports
   const rolePorts=service?[...new Set(Object.values(service.names).flatMap(t=>[t.http,t.tls]).filter(Boolean))].map(p=>'127.0.0.1:'+p):[];
   if(service)await json(path.join(dir,'worker.json'),{names:service.names,tlsPort:ports.ingress,httpPort:ports.redirect});
   else if(ingress){
    const token=randomBytes(32).toString('hex');""")
rep("""    const policies=[{directory:wgDir,appContainer:true,tunnel:true,programs:[{path:files.wg,udp:[udpPeer],connect:ingress?[`127.0.0.1:${ports.ingress}`,`127.0.0.1:${ports.redirect}`]:[],listen:[ports.socks,ports.control,ports.guardSocks]}]}];
    if(ingress)policies.push({directory:dir,appContainer:true,programs:[{path:files.node,connect:['127.0.0.1:'+broker.port],listen:[ports.ingress,ports.redirect]}]});""","""    const dnsTcp=service?.dns?.tcp?[`127.0.0.1:${service.dns.tcp}`]:[],dnsUdp=service?.dns?.udp?[`127.0.0.1:${service.dns.udp}`]:[];
    const policies=[{directory:wgDir,appContainer:true,tunnel:true,programs:[{path:files.wg,udp:[udpPeer,...dnsUdp],connect:ingress?[`127.0.0.1:${ports.ingress}`,`127.0.0.1:${ports.redirect}`,...dnsTcp]:[],listen:[ports.socks,ports.control,ports.guardSocks]}]}];
    if(ingress)policies.push({directory:dir,appContainer:true,programs:[{path:files.node,connect:service?rolePorts:['127.0.0.1:'+broker.port],listen:[ports.ingress,ports.redirect]}]});""")
rep("""    exitGrant=await this.grants.request({provider:exit,url:`http://${outer.control}`,role:exitRole,deploymentId,wgPublicKey:keys.exit.publicKey,ingress,egress});
   }""","""    exitGrant=await this.grants.request({provider:exit,url:`http://${outer.control}`,role:exitRole,deploymentId,wgPublicKey:keys.exit.publicKey,ingress,egress});
    if(service&&!sameNames(exitGrant.names,service.granted))throw Object.assign(new Error('the exit granted other names than this host\\'s service names'),{providerRole:'public'});
   }""")
rep("""   send({type:'inner',...(kind!=='network'&&this.paceMbps?{paceMbps:this.paceMbps}:{}),peer:inner,...(egress?{egress:{user:'',pass:'',listen:`127.0.0.1:${ports.socks}`}}:{}),
    ...(ingress?{ingress:{'443':`127.0.0.1:${ports.ingress}`,'80':`127.0.0.1:${ports.redirect}`}}:{})});""","""   send({type:'inner',...(kind!=='network'&&this.paceMbps?{paceMbps:this.paceMbps}:{}),peer:inner,...(egress?{egress:{user:'',pass:'',listen:`127.0.0.1:${ports.socks}`}}:{}),
    ...(ingress?{ingress:{'443':`127.0.0.1:${ports.ingress}`,'80':`127.0.0.1:${ports.redirect}`,...(service?.dns?.tcp?{'53':`127.0.0.1:${service.dns.tcp}`}:{})}}:{}),
    // DNS datagrams the exit forwards (kernel dns_dnat) to this host's tunnel address: relayed to the route-dns role
    ...(service?.dns?.udp?{udpIngress:{'53':`127.0.0.1:${service.dns.udp}`}}:{})});""")
rep("""     if(x2.clientAddress!==exitGrant.clientAddress)throw Object.assign(new Error('the exit changed this circuit\\'s address'),{providerRole:'public'});""","""     if(x2.clientAddress!==exitGrant.clientAddress)throw Object.assign(new Error('the exit changed this circuit\\'s address'),{providerRole:'public'});
     if(service&&!sameNames(x2.names,service.granted))throw Object.assign(new Error('the exit granted other names than this host\\'s service names'),{providerRole:'public'});""")
rep("""    tunnel:kind==='network'?{guard:guardGrant.clientAddress,exit:exitGrant.clientAddress}:{byo:byo.addresses[0]}});""","""    tunnel:kind==='network'?{guard:guardGrant.clientAddress,exit:exitGrant.clientAddress}:{byo:byo.addresses[0]},
    // a host-service circuit is withdrawn at the exit (a signed revoke through the guard) before it closes
    ...(service?{service:{names:exitGrant.names,exitKey:keys.exit.publicKey,control:outer.control}}:{})});""")
open(p,'w').write(s)
