import {publicPorts} from './public-fallback.mjs';
import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {EventEmitter} from 'node:events';import {randomBytes,createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import {createInterface} from 'node:readline';
import {AdapterProcess} from './adapter-process.mjs';import {DiscoveryPeer} from './discovery-peer.mjs';import {createAppBroker} from './app-broker.mjs';
const execute=promisify(execFile),digest=s=>createHash('sha256').update(s).digest('hex');
async function port(){const server=net.createServer();await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)});const value=server.address().port;await new Promise(r=>server.close(r));return value;}
async function json(file,value){await fs.writeFile(file,JSON.stringify(value),{mode:0o600});}
export class WindowsCircuitRuntime {
 constructor({directory,binary,nodeBinary,workerModule,discoveryBinary,firewallBinary,rpc,authorize,forward,billing,log=()=>{}}){
  if(process.platform!=='win32'||[directory,binary,nodeBinary,workerModule,discoveryBinary,firewallBinary].some(v=>typeof v!=='string'||!path.isAbsolute(v)))throw new Error('explicit Windows circuit runtime paths required');
  Object.assign(this,{directory,binary,nodeBinary,workerModule,discoveryBinary,firewallBinary,rpc,authorize,forward,billing,log});this.active=new Set();this.closed=false;this.ownership=null;
 }
 async own(){
  if(this.ownership)return this.ownership;
  this.ownership=(async()=>{
   await fs.mkdir(this.directory,{recursive:true});if(this.closed)throw new Error('runtime stopped');const server=net.createServer(s=>s.destroy());this.ownerServer=server;
   await new Promise((r,j)=>{server.once('error',j);server.listen('\\\\.\\pipe\\enclave-tuna-runtime-'+digest(this.directory.toLowerCase()).slice(0,32),r)});
  })();return this.ownership;
 }
 async close(){this.closed=true;await Promise.all([...this.active].map(c=>c.close('runtime stopped')));this.ownerServer?.close();}
 async prepare(directory){
  await fs.mkdir(directory,{recursive:true});const manifest=path.join(directory,'firewall.json');
  try{await fs.access(manifest);await execute(this.firewallBinary,['remove',manifest],{timeout:20000});await fs.rename(manifest,path.join(directory,'firewall-removed-'+Date.now()+'.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 async start({deploymentId,names,providers,wallets,maxPrice,policy}){
  const usdc=policy?.currency==='USDC';if(usdc&&!this.billing)throw new Error('USDC TUNA controller required');
  const scopes=[],billingPorts={};
  if(this.closed)throw new Error('runtime stopped');await this.own();if(this.closed)throw new Error('runtime stopped');
  const id=randomBytes(16).toString('hex'),dir=path.join(this.directory,'enclave-circuit-'+digest(wallets.public.address).slice(0,32)),guardDir=path.join(this.directory,'enclave-circuit-'+digest(wallets.guard.address).slice(0,32));
  const circuit=new EventEmitter();Object.assign(circuit,{id,deploymentId,providers,closed:false});this.active.add(circuit);
  const children=[],exits=[],adapters=[];let broker,discovery,worker,workerLines,readyReject,timer,egressServer;const sockets=new Set();let installed=[],closing;
  const launch=(directory,role)=>{
   if(circuit.closed||this.closed)throw new Error('runtime stopped');
   const child=spawn(this.firewallBinary,['sandbox',path.join(directory,role+'-sandbox.json')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
   children.push(child);exits.push(new Promise(resolve=>{child.once('error',resolve);child.once('exit',resolve)}));return child;
  };
  circuit.close=reason=>{
   if(closing)return closing;circuit.closed=true;closing=(async()=>{clearTimeout(timer);readyReject?.(new Error(reason||'circuit closed'));
   broker?.revoke();for(const s of sockets)s.destroy();egressServer?.close();for(const a of adapters)a.close();discovery?.close();workerLines?.close();
   for(const child of children){child.stdin.destroy();if(child.exitCode===null)child.kill();}
   await Promise.all(exits);await broker?.close();await Promise.all(scopes.map(s=>s.close()));
   for(const folder of installed)await execute(this.firewallBinary,['remove',path.join(folder,'firewall.json')],{timeout:20000}).catch(e=>this.log('circuit cleanup: '+e.message));
   this.active.delete(circuit);circuit.emit('down',reason||'closed');
   })();return closing;
  };
  circuit.admit=expiresAt=>{if(!circuit.closed&&worker?.stdin.writable)worker.stdin.write(JSON.stringify({type:'admission',expiresAt})+'\n');if(expiresAt<=Date.now()){broker?.revoke();for(const s of sockets)s.destroy();}};
  circuit.publishDiscovery=value=>{if(circuit.closed||!discovery)throw new Error('discovery unavailable');discovery.update(value);};
  try{
   await this.prepare(dir);await this.prepare(guardDir);await fs.mkdir(path.join(dir,'state'),{recursive:true});
   const [guardPort,ingressPort,redirectPort,egressPort]=await Promise.all([port(),port(),port(),port()]);
   if(new Set([guardPort,ingressPort,redirectPort,egressPort]).size!==4)throw new Error('local circuit port collision');
   const token=randomBytes(32).toString('hex');broker=await createAppBroker({tcpPort:0,token,deploymentId,authorize:this.authorize,forward:this.forward,log:this.log});
   const files={node:path.join(dir,'worker.exe'),public:path.join(dir,'tuna-public.exe'),egress:path.join(dir,'tuna-egress.exe'),discovery:path.join(dir,'discovery.exe'),guard:path.join(guardDir,'tuna-guard.exe')};
   await Promise.all([[this.nodeBinary,files.node],[this.binary,files.public],[this.binary,files.egress],[this.discoveryBinary,files.discovery],[this.binary,files.guard],[this.workerModule,path.join(dir,'worker.mjs')]].map(([from,to])=>fs.copyFile(from,to)));
   const seen=new Set();for(const role of ['guard','public','egress']){
    const wallet=wallets[role];if(!wallet||!path.isAbsolute(wallet.seedFile)||seen.has(wallet.address))throw new Error('distinct funded role identities required');seen.add(wallet.address);
    const derived=JSON.parse((await execute(this.binary,['--wallet-address',wallet.seedFile],{timeout:10000})).stdout);if(derived.address!==wallet.address)throw new Error('wallet manifest mismatch');
    const folder=role==='guard'?guardDir:dir,seedFile=path.join(folder,role+'.seed');await fs.copyFile(wallet.seedFile,seedFile);
    let usdcConfig;
    if(usdc){const scope=await this.billing.scope({deploymentId,providerId:providers[role].registryId});scopes.push(scope);billingPorts[role]='127.0.0.1:'+scope.port;const tokenFile=path.join(folder,role+'.token');await fs.writeFile(tokenFile,scope.token,{mode:0o600});usdcConfig={endpoint:'http://'+billingPorts[role]+'/',tokenFile,deploymentId,providerId:providers[role].registryId};}
    const config={...(usdc?{usdc:usdcConfig}:{}),seedFile,rpc:this.rpc,maxPrice:usdc?'0':maxPrice,minBalance:usdc?'0':'0.01',allowProviders:[providers[role].identity],denyProviders:[],listenIp:'127.0.0.1',requireGuard:role!=='guard',...(role!=='guard'?{guardSocks:'127.0.0.1:'+guardPort}:{}),...(role==='public'?{subscriptionState:path.join(dir,'state','subscription.json')}: {})};
    await json(path.join(folder,role+'.json'),config);await json(path.join(folder,role+'-sandbox.json'),{directory:folder,executable:files[role],args:['--config',path.join(folder,role+'.json')]});
   }
   await json(path.join(dir,'worker.json'),{deploymentId,names,ingressPort,redirectPort,broker:{port:broker.port,token}});
   await json(path.join(dir,'node-sandbox.json'),{directory:dir,executable:files.node,args:['--preserve-symlinks','--preserve-symlinks-main',path.join(dir,'worker.mjs'),path.join(dir,'worker.json')]});
   await json(path.join(dir,'discovery-sandbox.json'),{directory:dir,executable:files.discovery,args:['--config',path.join(dir,'public.json'),'--deployment',deploymentId]});
   const guardAddress='127.0.0.1:'+guardPort;
   const policies=[{directory:guardDir,appContainer:true,publicNetwork:true,programs:[{path:files.guard,connect:usdc?[billingPorts.guard]:[],listen:[guardPort]}]},
    {directory:dir,appContainer:true,programs:[{path:files.node,connect:['127.0.0.1:'+broker.port],listen:[ingressPort,redirectPort]},
     {path:files.public,connect:[...(usdc?[billingPorts.public]:[]),guardAddress,'127.0.0.1:'+ingressPort,'127.0.0.1:'+redirectPort],listen:[]},
     {path:files.egress,connect:[guardAddress,...(usdc?[billingPorts.egress]:[])],listen:[egressPort]},{path:files.discovery,connect:[guardAddress],listen:[]}]}];
   for(const policy of policies){if(circuit.closed||this.closed)throw new Error('runtime stopped');const file=path.join(policy.directory,'firewall-config.json');await json(file,policy);installed.push(policy.directory);await execute(this.firewallBinary,['install',file],{timeout:30000});}
   const makeAdapter=(role,route)=>{const directory=role==='guard'?guardDir:dir;const adapter=new AdapterProcess({binary:files[role],configFile:path.join(directory,role+'.json'),provider:providers[role],route,spawnProcess:()=>launch(directory,role),log:this.log});adapters.push(adapter);adapter.on('down',e=>{circuit.failureRole=e.providerRole;void circuit.close(e.message)});return adapter;};
   const guard=makeAdapter('guard',{id:'guard',tcp:[guardPort],udp:[],forward:true});await guard.start({timeoutMs:45000});
   await new Promise((resolve,reject)=>{
    readyReject=reject;timer=setTimeout(()=>reject(new Error('Windows ingress startup timeout')),15000);worker=launch(dir,'node');worker.stdin.on('error',()=>{});worker.stderr.on('data',b=>this.log(String(b).slice(0,1000)));
    worker.once('error',reject);worker.once('exit',()=>{void circuit.close('Windows ingress exited')});workerLines=createInterface({input:worker.stdout});workerLines.on('line',line=>{try{const event=JSON.parse(line);if(event.type==='ready'&&event.ingress===ingressPort&&event.redirect===redirectPort)resolve();}catch{}});
   });clearTimeout(timer);readyReject=null;
   const publicRole=makeAdapter('public',{id:'https',tcp:[ingressPort,redirectPort],publicTcp:publicPorts(providers.public),udp:[],randomPorts:false});
   const egress=makeAdapter('egress',{id:'egress',tcp:[egressPort],udp:[],forward:true});
   const [allocation]=await Promise.all([publicRole.start(),egress.start()]);
   discovery=new DiscoveryPeer({binary:files.discovery,configFile:path.join(dir,'public.json'),deploymentId,spawnProcess:()=>launch(dir,'discovery'),log:this.log});discovery.on('down',e=>{void circuit.close(e.message)});await discovery.start();
   if(circuit.closed||this.closed)throw new Error('circuit stopped during startup');
   egressServer=net.createServer(socket=>{
    if(circuit.closed||!this.authorize(deploymentId)||sockets.size>=1024){socket.destroy();return;}sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
    const upstream=net.connect({host:'127.0.0.1',port:egressPort});const close=()=>{socket.destroy();upstream.destroy()};socket.on('error',close);upstream.on('error',close);socket.once('close',close);upstream.once('close',close);socket.pipe(upstream).pipe(socket);
   });await new Promise((r,j)=>{egressServer.once('error',j);egressServer.listen(0,'127.0.0.1',r)});
   Object.assign(circuit,{address:allocation.address,port:443,...(allocation.tcp[0]!==443?{directPort:allocation.tcp[0]}:{}),egress:'127.0.0.1:'+egressServer.address().port,isolation:{platform:'windows',directory:dir,guardDirectory:guardDir,guardAddress}});return circuit;
  }catch(e){await circuit.close(e.message);throw e;}
 }
}
