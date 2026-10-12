// netns e2e helper: a real provider (kernel wg + nftables + router + control) with an always-valid fake lease.
import fs from 'node:fs/promises';
import {privateKeyToAccount} from 'viem/accounts';
import {Kernel} from '../../network/wg-provider/kernel.mjs';
import {WgProvider} from '../../network/wg-provider/provider.mjs';
import {createRouter} from '../../network/wg-provider/router.mjs';
import {createControl} from '../../network/wg-provider/control.mjs';
const [publicAddress,roles,keyDir,out,operatorKey,targetsJson,checker]=process.argv.slice(2);
const account=privateKeyToAccount(operatorKey);
const kernel=new Kernel({publicAddress,uplink:'eth0',keyDir});
const keys=await kernel.ensure();
const lease={active:true,runner:'0x'+'11'.repeat(32),runnerOperator:process.env.RUNNER_OPERATOR,owner:'0x'+'22'.repeat(20),isPublic:true,validUntil:Date.now()+3600e3,leaseUntil:Date.now()+3600e3};
const seen=new Map();
const provider=new WgProvider({config:{providerId:'aa'.repeat(16),roles:roles.split(','),pricePerGiB6:0,publicAddress,exitKey:keys['wg-exit'],guardKey:keys['wg-guard'],ports:{exit:51820,guard:51821,control:51822},checkers:checker?[checker]:[]},
 signer:account,kernel,leases:async()=>lease,policyMemory:{get:async k=>seen.get(k),set:async(k,v)=>seen.set(k,v)},domains:async()=>['www.example.org'],
 targets:async()=>JSON.parse(targetsJson||'[]'),log:m=>console.error('[provider]',m)});
await provider.sync();
await createRouter({port:443,route:n=>provider.route(n),tls:true});
await createRouter({port:80,route:n=>provider.route(n),tls:false});
await createControl({provider,port:51822,info:()=>({keys})});
await fs.writeFile(out,JSON.stringify({keys,publicAddress,operator:account.address.toLowerCase()}));
console.error('[provider] up',publicAddress);
setInterval(()=>provider.sweep().catch(()=>{}),5000);
