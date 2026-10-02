#!/usr/bin/env node
// Runs INSIDE a sealed network namespace. Only the guard's literal IP:port is
// reachable. The host hands this process a single app's Unix ingress socket.
import fs from 'node:fs';
import {createInterface} from 'node:readline';
import {spliceAppBroker} from './broker-client.mjs';
import {AdapterProcess} from './adapter-process.mjs';
import {createAppIngress} from './app-ingress.mjs';
import {createAppRedirect} from './app-redirect.mjs';
import {DiscoveryPeer} from './discovery-peer.mjs';
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
let admittedUntil=0,closed=false,discovery=null,pendingDiscovery=null;
const children=[],emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const ingress=await createAppIngress({deploymentId:cfg.deploymentId,names:cfg.names,allowNoSni:true,
 onError:e=>process.stderr.write('app ingress: '+e.message+'\n'),
 authorize:id=>!closed&&id===cfg.deploymentId&&admittedUntil>Date.now(),
 forward:socket=>spliceAppBroker(socket,cfg.appSocket)});
const redirect=await createAppRedirect({deploymentId:cfg.deploymentId,names:cfg.names,authorize:id=>!closed&&id===cfg.deploymentId&&admittedUntil>Date.now()});
function close(reason){if(closed)return;closed=true;admittedUntil=0;ingress.close();redirect.close();for(const child of children)child.close();discovery?.close();emit({type:'down',reason});clearInterval(timer);setTimeout(()=>process.exit(0),500).unref();}
const timer=setInterval(()=>{if(admittedUntil<=Date.now()){ingress.revoke();redirect.revoke();}},250);
const commands=createInterface({input:process.stdin});
commands.on('line',line=>{try{const m=JSON.parse(line);if(m.type==='admission'&&Number.isSafeInteger(m.expiresAt)&&m.expiresAt<=Date.now()+120000){admittedUntil=m.expiresAt;if(admittedUntil<=Date.now()){ingress.revoke();redirect.revoke();}}else if(m.type==='discovery'){pendingDiscovery=m.value;if(discovery)discovery.update(pendingDiscovery);}else if(m.type==='stop')close('stopped');}catch{close('invalid command');}});
commands.once('close',()=>close('manager disconnected'));process.once('SIGTERM',()=>close('terminated'));process.once('SIGINT',()=>close('interrupted'));
try{
 const publicProcess=new AdapterProcess({binary:cfg.binary,configFile:cfg.publicConfig,provider:cfg.providers.public,
  route:{id:'https',tcp:[ingress.port,redirect.port],publicTcp:[443,80],udp:[],randomPorts:false},log:s=>process.stderr.write(s)});
 const egressProcess=new AdapterProcess({binary:cfg.binary,configFile:cfg.egressConfig,provider:cfg.providers.egress,
  route:{id:'egress',tcp:[30489],udp:[],forward:true},log:s=>process.stderr.write(s)});
 children.push(publicProcess,egressProcess);for(const child of children)child.on('down',e=>close(e.message));
 const [allocation]=await Promise.all(children.map(child=>child.start()));
 if(cfg.discoveryBinary&&!closed){
  discovery=new DiscoveryPeer({binary:cfg.discoveryBinary,configFile:cfg.publicConfig,deploymentId:cfg.deploymentId,log:s=>process.stderr.write(s+'\n')});
  discovery.on('down',e=>close(e.message));
  await discovery.start();if(pendingDiscovery)discovery.update(pendingDiscovery);
 }
 if(!closed)emit({type:'ready',address:allocation.address,port:allocation.tcp[0],provider:allocation.provider,egress:true});
}catch(e){close(e.message);process.exitCode=1;}
