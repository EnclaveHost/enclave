// One-hop qualification: the host's real WgCircuitRuntime (plain mode, real enclave-wg, ingress worker and broker) with
// one app circuit: through a guard, or with '-' for the guard, one hop to the exit. The owner's policy is read from a
// file at every request, so a changed policy reaches the next renewal. The runtime is main's source, or with
// OH_RUNTIME=<module> whatever that module puts in globalThis.__ohRuntime ({WgCircuitRuntime, WgGrants}).
import net from 'node:net';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {privateKeyToAccount} from 'viem/accounts';
let M;
if(process.env.OH_RUNTIME){await import(process.env.OH_RUNTIME).catch(e=>{if(e.message!=='__oh_stop')throw e;});M=globalThis.__ohRuntime;}
else M={WgCircuitRuntime:(await import('../../../network/wg-circuit-runtime.mjs')).WgCircuitRuntime,WgGrants:(await import('../../../network/wg-grants.mjs')).WgGrants};
const [wgBinary,id,gFile,gAddr,xFile,xAddr,runnerKey,appPort,policyFile]=process.argv.slice(2);
const rec=(f,address)=>{const j=JSON.parse(fs.readFileSync(f,'utf8'));return {providerId:'aa'.repeat(16),operator:j.operator,address,wgExitKey:j.keys['wg-exit'],wgGuardKey:j.keys['wg-guard'],ports:{exit:51820,guard:51821,control:51822},region:'test'};};
const guard=gFile==='-'?null:rec(gFile,gAddr),exit=rec(xFile,xAddr);
const policy=async()=>{if(!policyFile||policyFile==='-')return null;try{return JSON.parse(fs.readFileSync(policyFile,'utf8'));}catch{return null;}};
const runtime=new M.WgCircuitRuntime({directory:fs.mkdtempSync(path.join(os.tmpdir(),'ohrt-')),wgBinary,nodeBinary:process.execPath,
 workerModule:path.resolve('network/windows-circuit-worker.mjs'),platform:'plain',renewMs:5000,resolvers:['44.0.0.1'],
 grants:new M.WgGrants({account:privateKeyToAccount(runnerKey),runner:'0x'+'11'.repeat(32),policy}),
 authorize:()=>true,forward:socket=>{const up=net.connect(+appPort,'127.0.0.1');socket.pipe(up).pipe(socket);up.on('error',()=>socket.destroy());socket.on('error',()=>up.destroy());},
 log:m=>console.error('[runtime]',m)});
const c=await runtime.start({deploymentId:id,names:[id.slice(2,10)+'.app.enclave.host'],kind:'network',guard,exit,ingress:true,egress:true});
setInterval(()=>c.admit(Date.now()+60000),1000);c.admit(Date.now()+60000);
c.on('down',r=>{console.error('[runtime] circuit down:',r?.message||r);process.exit(1);});
console.log(JSON.stringify({egress:c.egress,oneHop:c.oneHop===true,tunnel:c.tunnel}));
