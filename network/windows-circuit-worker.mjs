#!/usr/bin/env node
import fs from 'node:fs';import {createInterface} from 'node:readline';
import {createAppIngress} from './app-ingress.mjs';import {createAppRedirect} from './app-redirect.mjs';import {spliceAppBroker} from './broker-client.mjs';
// Role executables are launched separately by the trusted parent, each into the
// verified circuit AppContainer. This worker never needs to create a child.
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
let until=0,closed=false;
const authorize=id=>!closed&&id===cfg.deploymentId&&until>Date.now();
const ingress=await createAppIngress({deploymentId:cfg.deploymentId,names:cfg.names,port:cfg.ingressPort,allowNoSni:true,authorize,forward:socket=>spliceAppBroker(socket,cfg.broker)});
const redirect=await createAppRedirect({deploymentId:cfg.deploymentId,names:cfg.names,port:cfg.redirectPort,authorize});
function close(){if(closed)return;closed=true;until=0;ingress.close();redirect.close();clearInterval(timer);}
const timer=setInterval(()=>{if(until<=Date.now()){ingress.revoke();redirect.revoke();}},250);
const commands=createInterface({input:process.stdin});commands.on('line',line=>{
 try{const event=JSON.parse(line);if(event.type==='stop')close();else if(event.type==='admission'&&Number.isSafeInteger(event.expiresAt)&&event.expiresAt<=Date.now()+120000){until=event.expiresAt;if(until<=Date.now()){ingress.revoke();redirect.revoke();}}else close();}catch{close();}
});commands.once('close',close);process.once('SIGTERM',close);process.once('SIGINT',close);
console.log(JSON.stringify({type:'ready',ingress:ingress.port,redirect:redirect.port}));
