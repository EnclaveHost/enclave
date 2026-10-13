// netns e2e helper: the host's real WgCircuitRuntime (plain mode) with the real ingress worker and broker: one network
// circuit (guard G, exit X, ingress + egress); public visitors are spliced to the TLS "enclave" on 127.0.0.1:<port>.
import net from 'node:net';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {privateKeyToAccount} from 'viem/accounts';
import {WgCircuitRuntime} from '../../network/wg-circuit-runtime.mjs';
import {WgGrants} from '../../network/wg-grants.mjs';
const [wgBinary,gFile,xFile,runnerKey,appPort]=process.argv.slice(2);
const rec=(f,address)=>{const j=JSON.parse(fs.readFileSync(f,'utf8'));return {providerId:'aa'.repeat(16),operator:j.operator,address,wgExitKey:j.keys['wg-exit'],wgGuardKey:j.keys['wg-guard'],ports:{exit:51820,guard:51821,control:51822},region:'test'};};
const guard=rec(gFile,'46.0.0.2'),exit=rec(xFile,'47.0.0.2');
const id='0x'+'ab'.repeat(32);
const runtime=new WgCircuitRuntime({directory:fs.mkdtempSync(path.join(os.tmpdir(),'wgrt-')),wgBinary,nodeBinary:process.execPath,
 workerModule:path.resolve('network/windows-circuit-worker.mjs'),platform:'plain',renewMs:5000,resolvers:['44.0.0.1'],
 grants:new WgGrants({account:privateKeyToAccount(runnerKey),runner:'0x'+'11'.repeat(32)}),
 authorize:()=>true,forward:socket=>{const up=net.connect(+appPort,'127.0.0.1');socket.pipe(up).pipe(socket);up.on('error',()=>socket.destroy());socket.on('error',()=>up.destroy());},
 log:m=>console.error('[runtime]',m)});
const c=await runtime.start({deploymentId:id,names:['abababab.app.enclave.host','www.example.org'],kind:'network',guard,exit,ingress:true,egress:true});
setInterval(()=>c.admit(Date.now()+60000),1000);c.admit(Date.now()+60000);
c.on('down',r=>{console.error('[runtime] circuit down:',r);process.exit(1);});
// the host's own control circuit (no app: registry-checked, egress only)
const ctl=await runtime.start({deploymentId:'0x'+'0'.repeat(64),names:[],kind:'network',guard:exit,exit:guard,egress:true,exitRole:'control',gate:()=>true});
console.log(JSON.stringify({address:c.address,egress:c.egress,guardAddress:c.isolation.guardAddress,tunnel:c.tunnel,control:ctl.egress}));
