// One Enclave-network circuit on a host (docs/design/enclave-network.md): enclave-wg (WireGuard in-process) plus the
// existing ingress worker (SNI gate + broker splice). It returns the circuit object the managers already use:
//   {id, address, port, egress, isolation.guardAddress, transport, providers, admit(), close(), 'down'}
// kind 'network': host -> guard -> exit (ingress and/or egress). kind 'byo': the owner's own WireGuard peer, egress only.
// On Windows each process runs in its own AppContainer under exact WFP rules (enclave-circuit-firewall, tunnel mode);
// elsewhere ('plain') they are ordinary child processes whose only route out is the tunnel itself.
import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {EventEmitter} from 'node:events';import {randomBytes,createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import {createInterface} from 'node:readline';
import {createAppBroker} from './app-broker.mjs';
import {wireGuardKeypair} from './wg-grants.mjs';
const execute=promisify(execFile),digest=s=>createHash('sha256').update(s).digest('hex');
export const RENEW_MS=4*60000;
async function freePort(){const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r)});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function json(file,value){await fs.writeFile(file,JSON.stringify(value),{mode:0o600});}

export class WgCircuitRuntime {
 constructor({directory,wgBinary,nodeBinary,workerModule,firewallBinary,grants,authorize,forward,platform=process.platform==='win32'?'windows':'plain',renewMs=RENEW_MS,resolvers=['1.1.1.1','9.9.9.9'],log=()=>{}}){
  if([directory,wgBinary,nodeBinary,workerModule].some(v=>typeof v!=='string'||!path.isAbsolute(v))||(platform==='windows'&&!path.isAbsolute(firewallBinary||'')))throw new Error('explicit Enclave-network runtime paths required');
  Object.assign(this,{directory,wgBinary,nodeBinary,workerModule,firewallBinary,grants,authorize,forward,platform,renewMs,resolvers,log});this.active=new Set();this.closed=false;
 }
 async close(){this.closed=true;await Promise.all([...this.active].map(c=>c.close('runtime stopped')));}
 async prepare(dir){
  await fs.mkdir(dir,{recursive:true});if(this.platform!=='windows')return;
  const manifest=path.join(dir,'firewall.json');
  try{await fs.access(manifest);await execute(this.firewallBinary,['remove',manifest],{timeout:20000});await fs.rename(manifest,path.join(dir,'firewall-removed-'+Date.now()+'.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 // kind 'network': {guard, exit} verified provider records; ingress/egress what the policy authorizes on this circuit.
 // kind 'byo': byo = parsed WireGuard config (network/wg-config.mjs) with endpoint already resolved to {address,port}.
 async start({deploymentId,names,kind='network',guard,exit,byo,ingress=false,egress=false,fallback=false}){
  if(this.closed)throw new Error('runtime stopped');
  if(kind==='network'&&(!guard||!exit||guard.address===exit.address))throw new Error('a guard and a different exit are required');
  if(kind==='byo'&&(!byo||ingress))throw new Error('a BYO tunnel carries egress only');
  const id=randomBytes(16).toString('hex'),tag=digest(deploymentId+id).slice(0,32);
  const dir=path.join(this.directory,'enclave-circuit-'+tag),wgDir=path.join(this.directory,'enclave-circuit-'+digest('wg'+tag).slice(0,32));
  const circuit=new EventEmitter();Object.assign(circuit,{id,deploymentId,kind,closed:false,transport:kind==='byo'?'byo-wireguard':'enclave-network',fallback,
   providers:kind==='network'?{guard,exit,public:{address:exit.address,fallback}}:{byo:{address:byo.endpoint.address}}});
  this.active.add(circuit);
  const children=[],exits=[],sockets=new Set(),installed=[];let broker,worker,wg,wgLines,egressServer,renewTimer,closing,pending;
  const launch=(folder,exe,args)=>{
   if(circuit.closed||this.closed)throw new Error('runtime stopped');
   const child=this.platform==='windows'?spawn(this.firewallBinary,['sandbox',path.join(folder,path.basename(exe,'.exe')+'-sandbox.json')],{stdio:['pipe','pipe','pipe'],windowsHide:true})
    :spawn(exe,args,{stdio:['pipe','pipe','pipe']});
   children.push(child);exits.push(new Promise(r=>{child.once('error',r);child.once('exit',r);}));child.stdin.on('error',()=>{});return child;
  };
  circuit.close=reason=>{
   if(closing)return closing;circuit.closed=true;closing=(async()=>{clearInterval(renewTimer);pending?.reject?.(new Error(reason||'circuit closed'));
    broker?.revoke();for(const s of sockets)s.destroy();egressServer?.close();wgLines?.close();
    for(const c of children){c.stdin.destroy();if(c.exitCode===null)c.kill();}
    await Promise.all(exits);await broker?.close();
    for(const folder of installed)await execute(this.firewallBinary,['remove',path.join(folder,'firewall.json')],{timeout:20000}).catch(e=>this.log('circuit cleanup: '+e.message));
    this.active.delete(circuit);circuit.emit('down',reason||'closed');
   })();return closing;
  };
  circuit.admit=expiresAt=>{
   if(!circuit.closed&&worker?.stdin.writable)worker.stdin.write(JSON.stringify({type:'admission',expiresAt})+'\n');
   if(expiresAt<=Date.now()){broker?.revoke();for(const s of sockets)s.destroy();if(wg?.stdin.writable)wg.stdin.write(JSON.stringify({type:'admission',open:false})+'\n');}
  };
  circuit.publishDiscovery=()=>{};   // routes are published through the relay, not a peer-to-peer network
  try{
   await this.prepare(dir);await this.prepare(wgDir);
   const ports={ingress:await freePort(),redirect:await freePort(),socks:await freePort(),control:await freePort(),guardSocks:await freePort()};
   if(new Set(Object.values(ports)).size!==5)throw new Error('local circuit port collision');
   const files={wg:this.platform==='windows'?path.join(wgDir,'enclave-wg.exe'):this.wgBinary,node:this.platform==='windows'?path.join(dir,'worker.exe'):this.nodeBinary};
   if(this.platform==='windows')await Promise.all([[this.wgBinary,files.wg],[this.nodeBinary,files.node],[this.workerModule,path.join(dir,'worker.mjs')]].map(([a,b])=>fs.copyFile(a,b)));
   const workerModule=this.platform==='windows'?path.join(dir,'worker.mjs'):this.workerModule;
   // the control plane: who the tunnels are with
   let guardGrant,exitGrant,keys={guard:wireGuardKeypair(),exit:wireGuardKeypair()};
   if(kind==='network'){
    guardGrant=await this.grants.request({provider:guard,url:`http://${guard.address}:${guard.ports.control}`,role:'guard',deploymentId,wgPublicKey:keys.guard.publicKey});
   }
   const udpPeer=kind==='network'?`${guard.address}:${guard.ports.guard}`:`${byo.endpoint.address}:${byo.endpoint.port}`;
   if(ingress){
    const token=randomBytes(32).toString('hex');
    broker=await createAppBroker({tcpPort:0,token,deploymentId,authorize:this.authorize,forward:this.forward,log:this.log});
    await json(path.join(dir,'worker.json'),{deploymentId,names,ingressPort:ports.ingress,redirectPort:ports.redirect,broker:{port:broker.port,token}});
   }
   if(this.platform==='windows'){
    const policies=[{directory:wgDir,appContainer:true,tunnel:true,programs:[{path:files.wg,udp:[udpPeer],connect:ingress?[`127.0.0.1:${ports.ingress}`,`127.0.0.1:${ports.redirect}`]:[],listen:[ports.socks,ports.control,ports.guardSocks]}]}];
    if(ingress)policies.push({directory:dir,appContainer:true,programs:[{path:files.node,connect:['127.0.0.1:'+broker.port],listen:[ports.ingress,ports.redirect]}]});
    await json(path.join(wgDir,'enclave-wg-sandbox.json'),{directory:wgDir,executable:files.wg,args:[]});
    if(ingress)await json(path.join(dir,'worker-sandbox.json'),{directory:dir,executable:files.node,args:['--preserve-symlinks','--preserve-symlinks-main',workerModule,path.join(dir,'worker.json')]});
    for(const p of policies){if(circuit.closed)throw new Error('runtime stopped');const f=path.join(p.directory,'firewall-config.json');await json(f,p);installed.push(p.directory);await execute(this.firewallBinary,['install',f],{timeout:30000});}
   }
   // the data plane
   wg=launch(wgDir,files.wg,[]);wg.stderr.on('data',b=>this.log(String(b).slice(0,1000)));
   wgLines=createInterface({input:wg.stdout});
   const events=new EventEmitter();
   wgLines.on('line',line=>{if(line.length>65536)return;let v;try{v=JSON.parse(line);}catch{return;}
    if(v.type==='down'){circuit.failureRole=/^outer|^guard/.test(v.error||'')?'guard':'public';void circuit.close(v.error);}
    else if(v.type==='stats'){circuit.stats=v;}else events.emit(v.type,v);});
   wg.once('exit',()=>void circuit.close('tunnel process exited'));
   const next=(type,ms=45000)=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error(type+' timeout')),ms);pending={reject};events.once(type,v=>{clearTimeout(t);pending=null;resolve(v);});});
   const send=v=>wg.stdin.write(JSON.stringify(v)+'\n');
   let outer;
   if(kind==='network'){
    send({type:'outer',peer:{privateKey:keys.guard.privateKey,publicKey:guardGrant.providerPublicKey,endpoint:guardGrant.endpoint,addresses:[guardGrant.clientAddress],mtu:1420,keepalive:25},
     control:`${exit.address}:${exit.ports.control}`,controlListen:`127.0.0.1:${ports.control}`,
     guardSocks:{listen:`127.0.0.1:${ports.guardSocks}`,only:[`${exit.address}:443`,`${exit.address}:80`]}});
    outer=await next('outer-ready');
    exitGrant=await this.grants.request({provider:exit,url:`http://${outer.control}`,role:'exit',deploymentId,wgPublicKey:keys.exit.publicKey,ingress,egress});
   }
   if(ingress){
    worker=launch(dir,files.node,['--preserve-symlinks','--preserve-symlinks-main',workerModule,path.join(dir,'worker.json')]);
    worker.stderr.on('data',b=>this.log(String(b).slice(0,1000)));worker.once('exit',()=>void circuit.close('ingress worker exited'));
    await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('ingress worker startup timeout')),15000);pending={reject};
     createInterface({input:worker.stdout}).on('line',l=>{try{const e=JSON.parse(l);if(e.type==='ready'&&e.ingress===ports.ingress&&e.redirect===ports.redirect){clearTimeout(t);pending=null;resolve();}}catch{}});});
   }
   const inner=kind==='network'
    ?{privateKey:keys.exit.privateKey,publicKey:exitGrant.providerPublicKey,endpoint:exitGrant.endpoint,addresses:[exitGrant.clientAddress],dns:this.resolvers,mtu:1340,keepalive:25}
    :{privateKey:byo.privateKey,publicKey:byo.publicKey,...(byo.presharedKey?{presharedKey:byo.presharedKey}:{}),endpoint:udpPeer,addresses:byo.addresses,dns:byo.dns,mtu:byo.mtu,keepalive:byo.keepalive||25};
   send({type:'inner',peer:inner,...(egress?{egress:{user:'',pass:'',listen:`127.0.0.1:${ports.socks}`}}:{}),
    ...(ingress?{ingress:{'443':`127.0.0.1:${ports.ingress}`,'80':`127.0.0.1:${ports.redirect}`}}:{})});
   const ready=await next('ready');
   if(egress&&ready.egress!==`127.0.0.1:${ports.socks}`)throw new Error('egress listener mismatch');
   // the app's egress entry: gated by admission here, then the tunnel's SOCKS
   if(egress){
    egressServer=net.createServer(socket=>{
     if(circuit.closed||!this.authorize(deploymentId)||sockets.size>=1024){socket.destroy();return;}sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
     const up=net.connect({host:'127.0.0.1',port:ports.socks});const close=()=>{socket.destroy();up.destroy();};socket.on('error',close);up.on('error',close);socket.once('close',close);up.once('close',close);socket.pipe(up).pipe(socket);
    });await new Promise((r,j)=>{egressServer.once('error',j);egressServer.listen(0,'127.0.0.1',r);});
   }
   // grants expire in 10 minutes: renew both well before; a refusal (lease ended, policy changed, provider unqualified) closes
   if(kind==='network')renewTimer=setInterval(()=>void(async()=>{
    try{
     await this.grants.request({provider:guard,url:`http://${guard.address}:${guard.ports.control}`,role:'guard',deploymentId,wgPublicKey:keys.guard.publicKey});
     await this.grants.request({provider:exit,url:`http://${outer.control}`,role:'exit',deploymentId,wgPublicKey:keys.exit.publicKey,ingress,egress});
    }catch(e){this.log(`circuit ${id}: renewal refused: ${e.message}`);circuit.failureRole=e.providerRole;void circuit.close('grant renewal failed: '+e.message);}
   })(),this.renewMs);
   if(circuit.closed||this.closed)throw new Error('circuit stopped during startup');
   Object.assign(circuit,{address:kind==='network'?exit.address:null,port:443,ingress,egressReady:!!egress,
    egress:egress?'127.0.0.1:'+egressServer.address().port:null,
    isolation:{platform:this.platform,directory:dir,wgDirectory:wgDir,guardAddress:kind==='network'?outer.guardSocks:null},
    tunnel:kind==='network'?{guard:guardGrant.clientAddress,exit:exitGrant.clientAddress}:{byo:byo.addresses[0]}});
   return circuit;
  }catch(e){await circuit.close(e.message);throw e;}
 }
}
