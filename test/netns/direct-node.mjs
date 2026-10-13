// netns e2e helper: direct hosting through the real host code (enclave-network-host's DirectRuntime + the manager):
// the host's own public address, its qualification signed by the test checker, one v5 direct app.
import net from 'node:net';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {EventEmitter} from 'node:events';
import {privateKeyToAccount} from 'viem/accounts';
import {createNetworkHost} from '../../network/enclave-network-host.mjs';
import {EnclaveNetworkManager} from '../../network/wg-manager.mjs';
import {qualifyProvider,PROVIDER_CHECKS} from '../../network/provider-qualification.mjs';
const [wgBinary,runnerKey,checkerKey,address,appPort]=process.argv.slice(2);
const account=privateKeyToAccount(runnerKey),checker=privateKeyToAccount(checkerKey),runner='0x'+'11'.repeat(32),id='0x'+'ab'.repeat(32);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'direct-'));
const q=await qualifyProvider({hostId:runner,operator:account.address,address,probe:Object.fromEntries(PROVIDER_CHECKS.map(k=>[k,async()=>true])),signer:checker,validForMs:300000});
fs.writeFileSync(dir+'/q.json',JSON.stringify(q));
const host=await createNetworkHost({config:{relay:'http://127.0.0.1:9',checkers:[checker.address],apps:'all',direct:{address,qualificationFile:dir+'/q.json'},
  wgBinary,nodeBinary:process.execPath,workerModule:path.resolve('network/windows-circuit-worker.mjs')},account,runner,rpc:[],leaseReader:{},directory:dir,
 authorize:()=>true,forward:socket=>{const up=net.connect(+appPort,'127.0.0.1');socket.pipe(up).pipe(socket);up.on('error',()=>socket.destroy());socket.on('error',()=>up.destroy());}});
const admission={allows:()=>true,leases:new Map([[id,{validUntil:Date.now()+3600e3}]]),proofs:new Map([[id,{validUntil:Date.now()+3600e3}]])};
let routes=[];
const m=new EnclaveNetworkManager({runtime:host.runtime,admission,providers:async()=>[],direct:host.direct,probe:async()=>{},publish:async(i,r)=>{routes=r;},log:x=>console.error('[direct]',x)});
await m.configure([{deploymentId:id,names:['abababab.app.enclave.host'],isPublic:true,policy:{version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'direct',fallback:'none',direct:{maxPricePerGiB6:0}}}]);
await m.reconcile();
const c=m.apps.get(id).circuits[0];
console.log(JSON.stringify({routes,egress:c?.egress,error:m.apps.get(id).error}));
setInterval(()=>{},1e9);
