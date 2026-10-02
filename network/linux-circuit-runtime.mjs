import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {AdapterProcess} from './adapter-process.mjs';
import {createAppBroker} from './app-broker.mjs';
const execute=promisify(execFile);
async function freePort(host){const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,host,r);});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const writeJSON=(file,value)=>fs.writeFile(file,JSON.stringify(value),{mode:0o600,flag:'wx'});

export class LinuxCircuitRuntime {
  constructor({directory,binary,image,network,gateway,rpc,authorize,forward,discovery=true,log=()=>{}}) {
    if(process.platform!=='linux'||process.getuid()!==1000)throw new Error('Linux circuit runtime requires the dedicated uid 1000 service account');
    if(!net.isIPv4(gateway)||!/^enclave-[a-z0-9-]+$/.test(network)||!image||!path.isAbsolute(directory)||!path.isAbsolute(binary))throw new Error('explicit runtime paths and network required');
    Object.assign(this,{directory,binary,image,network,gateway,rpc,authorize,forward,discovery,log});
  }
  async start({deploymentId,names,providers,wallets,maxPrice}) {
    const id=randomBytes(16).toString('hex'),dir=path.join(this.directory,id),privateDir=path.join(dir,'worker');
    await fs.mkdir(privateDir,{recursive:true,mode:0o700});
    const circuit=new EventEmitter();Object.assign(circuit,{id,deploymentId,providers,closed:false});
    let guard,child,broker,lines,readyReject,readyTimer,socketDirectory,egressServer;
    const egressSockets=new Set();
    const name='enclave-circuit-'+id;
    circuit.close=async reason=>{
      if(circuit.closed)return;circuit.closed=true;clearTimeout(readyTimer);readyReject?.(new Error(reason||'circuit closed'));
      broker?.revoke();for(const socket of egressSockets)socket.destroy();egressServer?.close();guard?.close();lines?.close();
      if(child?.stdin.writable)child.stdin.end(JSON.stringify({type:'stop'})+'\n');
      await execute('docker',['rm','-f',name],{timeout:15000}).catch(()=>{});
      await broker?.close();if(socketDirectory)await fs.rm(socketDirectory,{recursive:true,force:true});circuit.emit('down',reason||'closed');
    };
    circuit.publishDiscovery=value=>{if(circuit.closed||!child?.stdin.writable)throw new Error('circuit closed');child.stdin.write(JSON.stringify({type:'discovery',value})+'\n');};
    circuit.admit=expiresAt=>{if(!circuit.closed&&child?.stdin.writable)child.stdin.write(JSON.stringify({type:'admission',expiresAt})+'\n');if(expiresAt<=Date.now()){broker?.revoke();for(const socket of egressSockets)socket.destroy();}};
    try{
      const guardPort=await freePort(this.gateway);
      const seen=new Set();
      for(const role of ['guard','public','egress']){
        const wallet=wallets[role];
        if(!wallet||!path.isAbsolute(wallet.seedFile)||!/^NKN[1-9A-HJ-NP-Za-km-z]{25,45}$/.test(wallet.address)||seen.has(wallet.address))throw new Error('distinct funded role wallets required');
        seen.add(wallet.address);
        const derived=await execute(this.binary,['--wallet-address',wallet.seedFile],{timeout:10000});
        if(JSON.parse(derived.stdout).address!==wallet.address)throw new Error('wallet seed does not match its budget manifest');
        const seed=await fs.readFile(wallet.seedFile,'utf8');
        if(!/^[0-9a-f]{64}\s*$/i.test(seed))throw new Error('invalid wallet seed');
        const roleDir=role==='guard'?dir:privateDir,seedFile=path.join(roleDir,role+'.seed');
        await fs.writeFile(seedFile,seed,{mode:0o600,flag:'wx'});
        await writeJSON(path.join(roleDir,role+'.json'),{seedFile:role==='guard'?seedFile:'/etc/circuit/'+role+'.seed',rpc:this.rpc,maxPrice,minBalance:'0.01',
          allowProviders:[providers[role].identity],denyProviders:[],requireGuard:role!=='guard',
          ...(role==='guard'?{listenIp:this.gateway}:{guardSocks:`${this.gateway}:${guardPort}`,listenIp:role==='egress'?'0.0.0.0':'127.0.0.1'})});
      }
      socketDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'enclave-broker-'));
      await fs.chmod(socketDirectory,0o700);
      broker=await createAppBroker({socketPath:path.join(socketDirectory,'app.sock'),deploymentId,authorize:this.authorize,forward:this.forward,log:this.log});
      guard=new AdapterProcess({binary:this.binary,configFile:path.join(dir,'guard.json'),provider:providers.guard,
        route:{id:'guard',tcp:[guardPort],udp:[],forward:true},log:this.log});
      guard.on('down',e=>{void circuit.close(e.message)});
      await guard.start();
      if(circuit.closed)throw new Error('guard failed');
      await writeJSON(path.join(privateDir,'worker.json'),{deploymentId,names,providers,binary:'/opt/enclave-tuna/enclave-tuna',appSocket:'/run/app/app.sock',
        publicConfig:'/etc/circuit/public.json',egressConfig:'/etc/circuit/egress.json',...(this.discovery?{discoveryBinary:'/opt/enclave-tuna/enclave-route-discovery'}:{})});
      const ready=new Promise((resolve,reject)=>{
        readyReject=reject;readyTimer=setTimeout(()=>reject(new Error('guarded worker startup timeout')),180000);
        child=spawn('docker',['run','--rm','-i','--name',name,'--network',this.network,'--read-only','--security-opt','no-new-privileges',
          '--cap-drop','ALL','--cap-add','NET_ADMIN','--cap-add','SETUID','--cap-add','SETGID','--cap-add','SETPCAP',
          '--pids-limit','256','--memory','512m','--tmpfs','/tmp:rw,noexec,nosuid,size=32m',
          '-v',`${privateDir}:/etc/circuit:ro`,'-v',`${socketDirectory}:/run/app:ro`,
          this.image,this.gateway,String(guardPort)],{stdio:['pipe','pipe','pipe']});
        child.stdin.on('error',()=>{});child.stderr.on('data',b=>this.log(String(b).slice(0,2000)));
        child.once('error',reject);child.once('exit',(code,signal)=>{void circuit.close(`guarded worker exited (${signal||code})`)});
        lines=createInterface({input:child.stdout});lines.on('line',line=>{
          if(line.length>16384)return;let event;try{event=JSON.parse(line)}catch{return;}
          if(event.type==='ready'){
            if(event.provider!==providers.public.identity||event.address!==providers.public.address||event.port!==443||event.egress!==true){reject(new Error('unexpected guarded allocation'));return;}
            circuit.address=event.address;circuit.port=443;resolve();
          }else if(event.type==='down')reject(new Error(event.reason||'guarded circuit failed'));
        });
      });
      await ready;clearTimeout(readyTimer);readyReject=null;
      // The worker started only after installing its firewall, then dropped all
      // capabilities. Check the actual process credentials before publication.
      const {stdout}=await execute('docker',['exec',name,'sh','-c','cat /proc/1/status'],{timeout:10000});
      if(!/^Uid:\s+1000\s+1000\s+1000\s+1000$/m.test(stdout)||!/^CapEff:\s+0+$/m.test(stdout)||!/^CapBnd:\s+0+$/m.test(stdout)||!/^NoNewPrivs:\s+1$/m.test(stdout))throw new Error('worker isolation check failed');
      const inspected=await execute('docker',['inspect','--format','{{json .NetworkSettings.Networks}}',name],{timeout:10000});
      const workerAddress=JSON.parse(inspected.stdout)[this.network]?.IPAddress;
      if(!net.isIPv4(workerAddress))throw new Error('guarded worker has no private address');
      egressServer=net.createServer(socket=>{
        if(circuit.closed||!this.authorize(deploymentId)||egressSockets.size>=1024){socket.destroy();return;}
        egressSockets.add(socket);socket.once('close',()=>egressSockets.delete(socket));
        const upstream=net.connect({host:workerAddress,port:30489});const close=()=>{socket.destroy();upstream.destroy()};
        socket.on('error',close);upstream.on('error',close);socket.once('close',close);upstream.once('close',close);socket.pipe(upstream).pipe(socket);
      });
      await new Promise((resolve,reject)=>{egressServer.once('error',reject);egressServer.listen(0,'127.0.0.1',resolve);});
      circuit.egress='127.0.0.1:'+egressServer.address().port;
      circuit.isolation={platform:'linux',container:name,guardAddress:`${this.gateway}:${guardPort}`,capabilities:0,uid:1000};
      return circuit;
    }catch(e){await circuit.close(e.message);throw e;}
  }
}
