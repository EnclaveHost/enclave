import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AdapterProcess} from './adapter-process.mjs';
const execute=promisify(execFile);

// Control guards own only their bootstrap identity. They cannot open local
// app brokers or read the per-app circuit directories.
export async function windowsControlGuard({directory,binary,firewallBinary,rpc,wallet,provider,maxPrice,log,onDown}) {
  const hash=createHash('sha256').update(wallet.address).digest('hex').slice(0,32);
  const dir=path.join(directory,'enclave-circuit-'+hash),manifest=path.join(dir,'firewall.json');
  const owner=net.createServer(s=>s.destroy());let child,exited,adapter,installed=false,closing;
  const slot={provider,healthy:false};
  slot.close=()=>closing||=(async()=>{
    slot.healthy=false;adapter?.close();if(child?.exitCode===null)child.kill();await exited;
    if(installed)await execute(firewallBinary,['remove',manifest],{timeout:20000}).catch(e=>log('control cleanup: '+e.message));
    await new Promise(r=>owner.listening?owner.close(r):r());
  })();
  try {
    await fs.mkdir(dir,{recursive:true});
    await new Promise((r,j)=>{owner.once('error',j);owner.listen('\\\\.\\pipe\\enclave-control-'+hash,r);});
    try{await fs.access(manifest);await execute(firewallBinary,['remove',manifest],{timeout:20000});await fs.rename(manifest,path.join(dir,'firewall-removed-'+Date.now()+'.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const derived=JSON.parse((await execute(binary,['--wallet-address',wallet.seedFile],{timeout:10000})).stdout);
    if(derived.address!==wallet.address)throw new Error('control wallet mismatch');
    const executable=path.join(dir,'guard.exe'),seedFile=path.join(dir,'guard.seed');
    await fs.copyFile(binary,executable);await fs.copyFile(wallet.seedFile,seedFile);
    const server=net.createServer();await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)});const listen=server.address().port;await new Promise(r=>server.close(r));
    const write=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value));
    await write('guard.json',{seedFile,rpc,maxPrice,minBalance:'0.01',allowProviders:[provider.identity],denyProviders:[],listenIp:'127.0.0.1'});
    await write('sandbox.json',{directory:dir,executable,args:['--config',path.join(dir,'guard.json')]});
    await write('firewall-config.json',{directory:dir,appContainer:true,publicNetwork:true,programs:[{path:executable,connect:[],listen:[listen]}]});
    installed=true;await execute(firewallBinary,['install',path.join(dir,'firewall-config.json')],{timeout:30000});
    adapter=new AdapterProcess({binary:executable,configFile:path.join(dir,'guard.json'),provider,route:{id:'control',tcp:[listen],udp:[],forward:true},log,
      spawnProcess:()=>{child=spawn(firewallBinary,['sandbox',path.join(dir,'sandbox.json')],{stdio:['pipe','pipe','pipe'],windowsHide:true});exited=new Promise(r=>{child.once('error',r);child.once('exit',r)});return child;}});
    adapter.on('down',()=>{slot.healthy=false;if(!closing)onDown(slot);});
    slot.proxy='127.0.0.1:'+listen;
    await adapter.start({timeoutMs:45000});if(closing)throw new Error('control guard closed');slot.healthy=true;return slot;
  }catch(e){await slot.close();throw e;}
}
