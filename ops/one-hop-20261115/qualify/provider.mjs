// One-hop qualification: a provider on a real WireGuard device with nftables, its SNI router and its control API,
// behind a stand-in lease (any deployment: active, public, runner 0x11.., owner $OWNER). The provider code is main's
// source, or with OH_PROVIDER=<copy made by prep-bundle.py> the classes of an installed or patched bundle.
// What a stand-in cannot show: the bundle's own start-up (configuration, chain readers, the provider list it derives
// from the directory). Here the list of provider addresses is the one given on the command line.
import fs from 'node:fs/promises';
import {privateKeyToAccount} from 'viem/accounts';
let M;
if(process.env.OH_PROVIDER){await import(process.env.OH_PROVIDER).catch(e=>{if(e.message!=='__oh_stop')throw e;});M=globalThis.__oh;}
else M={Kernel:(await import('../../../network/wg-provider/kernel.mjs')).Kernel,WgProvider:(await import('../../../network/wg-provider/provider.mjs')).WgProvider,
 createRouter:(await import('../../../network/wg-provider/router.mjs')).createRouter,createControl:(await import('../../../network/wg-provider/control.mjs')).createControl};
const [publicAddress,roles,keyDir,out,operatorKey,targetsJson,providersJson]=process.argv.slice(2);
const account=privateKeyToAccount(operatorKey),runner='0x'+'11'.repeat(32);
const kernel=new M.Kernel({publicAddress,uplink:'eth0',keyDir});
const keys=await kernel.ensure();
const lease={active:true,runner,runnerOperator:process.env.RUNNER_OPERATOR,owner:process.env.OWNER,isPublic:true,validUntil:Date.now()+3600e3,leaseUntil:Date.now()+3600e3};
const seen=new Map(),others=new Set(JSON.parse(providersJson||'[]'));
const provider=new M.WgProvider({config:{providerId:'aa'.repeat(16),roles:roles.split(','),pricePerGiB6:0,publicAddress,exitKey:keys['wg-exit'],guardKey:keys['wg-guard'],ports:{exit:51820,guard:51821,control:51822},checkers:[]},
 signer:account,kernel,leases:async()=>lease,hosts:async id=>id===runner?{active:true,operator:process.env.RUNNER_OPERATOR.toLowerCase()}:null,policyMemory:{get:async k=>seen.get(k),set:async(k,v)=>seen.set(k,v)},domains:async()=>[],
 targets:async()=>JSON.parse(targetsJson||'[]'),providerAddresses:async()=>others,log:m=>console.error('[provider '+publicAddress+']',m)});
await provider.sync();
await M.createRouter({port:443,route:n=>provider.route(n),tls:true});
await M.createControl({provider,port:51822,info:()=>({keys}),log:m=>console.error('[control '+publicAddress+']',m)});
await fs.writeFile(out,JSON.stringify({keys,publicAddress,operator:account.address.toLowerCase()}));
console.error('[provider] up',publicAddress);
setInterval(()=>provider.sweep().catch(()=>{}),5000);
