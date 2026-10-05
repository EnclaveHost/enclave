import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AdapterProcess} from './adapter-process.mjs';
import {providerAllowed,independent} from './circuit-policy.mjs';
import {windowsControlGuard} from './windows-control-guard.mjs';
const execute=promisify(execFile);

// These two identities bootstrap public chain/discovery reads only. Guest
// sockets never use them. Each app's data continues to use its own circuits.
export class ControlTransport {
 constructor({directory,image,network,binary,firewallBinary,rpc,wallets,inventory,prefer=[],maxPrice='0.0002',log=()=>{}}){
  const supported=process.platform==='linux'&&process.getuid()===1000&&/^enclave-[a-z0-9-]+$/.test(network||'')||process.platform==='win32'&&typeof firewallBinary==='string'&&path.isAbsolute(firewallBinary);
  if(!supported||!path.isAbsolute(directory)||wallets.length!==2||wallets[0].address===wallets[1].address)throw new Error('two separate control identities and an isolated runtime required');
  Object.assign(this,{directory,image,network,binary,firewallBinary,rpc,wallets,inventory,prefer,maxPrice,log});this.slots=[null,null];this.pending=false;this.closed=false;this.cooldown=new Map();this.active=new Set();
 }
 proxies=()=>this.slots.filter(v=>v?.healthy).map(v=>v.proxy);
 async start(){await this.refresh();if(!this.proxies().length)throw new Error('no control bootstrap guard available');this.timer=setInterval(()=>void this.refresh().catch(e=>this.log(e.message)),20000);return this;}
 async refresh(){
  if(this.pending||this.closed)return;this.pending=true;
  try{
   const nodes=await this.inventory.get(),rule={allow:[],prefer:[],deny:[]};
   for(let i=0;i<2;i++){
    if(this.slots[i]?.healthy){
     const slot=this.slots[i],current=nodes.find(n=>n.identity===slot.provider.identity);
     if(current&&current.address===slot.provider.address&&current.beneficiary===slot.provider.beneficiary&&current.asn===slot.provider.asn&&providerAllowed(current,rule,this.maxPrice)){slot.provider=current;continue;}
     this.slots[i]=null;await slot.close();
    }
    const candidates=nodes.filter(n=>Number.isSafeInteger(n.asn)&&n.asn>0&&n.services.includes('socksproxy')&&providerAllowed(n,rule,this.maxPrice)&&(this.cooldown.get(n.identity)||0)<Date.now()&&this.slots.every(s=>!s||independent(s.provider,n,'beneficiary-and-network')))
      .sort((a,b)=>(this.prefer.includes(a.address)?0:1)-(this.prefer.includes(b.address)?0:1)||a.identity.localeCompare(b.identity));
    for(const provider of candidates.slice(0,3)){
     if(this.closed)return;
     let slot;try{slot=await this.allocate(i,provider);if(this.closed){await slot.close();return;}this.slots[i]=slot;break;}catch(e){this.cooldown.set(provider.identity,Date.now()+60000);this.log('control guard: '+e.message);}
    }
   }
  }finally{this.pending=false;}
 }
 async allocate(index,provider){
  if(process.platform==='win32'){
   const slot=await windowsControlGuard({...this,wallet:this.wallets[index],provider,onDown:slot=>{
    this.cooldown.set(provider.identity,Date.now()+60000);if(this.slots[index]===slot)this.slots[index]=null;void slot.close();
   }});
   const close=slot.close;slot.close=async()=>{await close();this.active.delete(slot);};this.active.add(slot);
   if(this.closed){await slot.close();throw new Error('control transport stopped');}return slot;
  }
  const wallet=this.wallets[index],id=randomBytes(16).toString('hex'),name='enclave-control-'+id,dir=path.join(this.directory,id);
  await fs.mkdir(dir,{recursive:true,mode:0o700});const seed=await fs.readFile(wallet.seedFile,'utf8');if(!/^[a-f0-9]{64}\s*$/i.test(seed))throw new Error('invalid control identity');
  const derived=JSON.parse((await execute(this.binary,['--wallet-address',wallet.seedFile],{timeout:10000})).stdout);if(derived.address!==wallet.address)throw new Error('control wallet mismatch');
  await fs.writeFile(path.join(dir,'seed'),seed,{mode:0o600,flag:'wx'});
  await fs.writeFile(path.join(dir,'resolv.conf'),'nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions use-vc attempts:1 timeout:2\n',{mode:0o600,flag:'wx'});
  await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({seedFile:'/etc/control/seed',rpc:this.rpc,maxPrice:this.maxPrice,minBalance:'0.01',allowProviders:[provider.identity],denyProviders:[],listenIp:'0.0.0.0'}),{mode:0o600,flag:'wx'});
  const slot={provider,name,healthy:false,proxy:null};let closed=false;
  const child=new AdapterProcess({binary:'/opt/enclave-tuna/enclave-tuna',configFile:'/etc/control/config.json',provider,route:{id:'control',tcp:[30489],udp:[],forward:true},log:this.log,
   spawnProcess:(binary,args,options)=>spawn('docker',['run','--rm','-i','--name',name,'--network',this.network,'--read-only','--cap-drop','ALL','--cap-add','NET_ADMIN','--cap-add','SETUID','--cap-add','SETGID','--cap-add','SETPCAP','--security-opt','no-new-privileges','--memory','256m','--pids-limit','128','-v',dir+':/etc/control:ro','-v',dir+'/resolv.conf:/etc/resolv.conf:ro','--entrypoint','/opt/enclave-tuna/public-guard-entrypoint.sh',this.image,'/etc/control/config.json'],options)});
  slot.close=async()=>{if(closed)return;closed=true;this.active.delete(slot);slot.healthy=false;child.close();await execute('docker',['rm','-f',name],{timeout:15000}).catch(()=>{});};
  this.active.add(slot);
  child.on('down',()=>{this.cooldown.set(provider.identity,Date.now()+60000);if(this.slots[index]===slot)this.slots[index]=null;void slot.close();});
  try{if(this.closed)throw new Error('control transport stopped');await child.start({timeoutMs:45000});if(closed)throw new Error('control guard closed');
   const inspected=JSON.parse((await execute('docker',['inspect','--format','{{json .NetworkSettings.Networks}}',name],{timeout:10000})).stdout),address=inspected[this.network]?.IPAddress;
   if(!net.isIPv4(address))throw new Error('control guard has no private network address');
   const status=(await execute('docker',['exec',name,'cat','/proc/1/status'],{timeout:10000})).stdout;
   if(!/^Uid:\s+1000\s+1000\s+1000\s+1000$/m.test(status)||!/^CapEff:\s+0+$/m.test(status)||!/^CapBnd:\s+0+$/m.test(status)||!/^NoNewPrivs:\s+1$/m.test(status))throw new Error('control guard isolation check failed');
   slot.proxy=address+':30489';slot.healthy=true;return slot;
  }catch(e){await slot.close();throw e;}
 }
 async close(){this.closed=true;clearInterval(this.timer);await Promise.all([...this.active].map(s=>s.close()));}
}
