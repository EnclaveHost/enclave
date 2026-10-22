// netns e2e helper: a real provider (kernel wg + nftables + router + control) carrying host services for ONE registered host.
// The platform host policy is a stand-in that admits unless <banFile> exists (then a definite ban), so the sweep path is real.
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {privateKeyToAccount} from 'viem/accounts';
import {Kernel} from '../../network/wg-provider/kernel.mjs';
import {WgProvider} from '../../network/wg-provider/provider.mjs';
import {createRouter} from '../../network/wg-provider/router.mjs';
import {createControl} from '../../network/wg-provider/control.mjs';
const [publicAddress,roles,keyDir,out,operatorKey,targetsJson,providerId,hostId,hostOperator,dns,banFile]=process.argv.slice(2);
const account=privateKeyToAccount(operatorKey);
const kernel=new Kernel({publicAddress,uplink:'eth0',keyDir,dns:dns==='1'?true:null});
const keys=await kernel.ensure();
const seen=new Map();
const provider=new WgProvider({config:{providerId,roles:roles.split(','),pricePerGiB6:0,publicAddress,exitKey:keys['wg-exit'],guardKey:keys['wg-guard'],ports:{exit:51820,guard:51821,control:51822},checkers:[],zone:'app.test',
  hostServices:{zone:'svc.test',platformHostPolicy:'on',maxHosts:4,...(dns==='1'?{dns:{hosts:[hostId],staleMs:180000}}:{})}},
 signer:account,kernel,leases:async()=>null,hosts:async id=>id===hostId?{active:true,operator:hostOperator.toLowerCase()}:null,
 hostAdmission:async ids=>Object.fromEntries(ids.map(id=>[id,existsSync(banFile)?{admit:false,status:'current',reason:'banned by platform policy #1 (registryId): netns test'}:{admit:true,status:'current',reason:null}])),
 policyMemory:{get:async k=>seen.get(k),set:async(k,v)=>seen.set(k,v)},domains:async()=>[],targets:async()=>JSON.parse(targetsJson||'[]'),log:m=>console.error('[provider]',m)});
await provider.sync();
await createRouter({port:443,route:n=>provider.route(n),tls:true});
await createRouter({port:80,route:n=>provider.route(n),tls:false});
await createControl({provider,port:51822,info:()=>({keys})});
await fs.writeFile(out,JSON.stringify({keys,publicAddress,operator:account.address.toLowerCase(),providerId}));
console.error('[provider] up',publicAddress);
setInterval(()=>provider.sweep().catch(e=>console.error('[provider] sweep',e.message)),2000);
