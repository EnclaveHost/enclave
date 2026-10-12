// enclave-wg-provider: runs an Enclave-network provider on a Linux server with a public IPv4 address.
//   node wg-provider.mjs /etc/enclave-network/provider.json
// config: {operatorKeyFile, publicAddress, uplink, roles, pricePerGiB6, region, kind, hostId, ports:{exit,guard,control},
//          rpc:[two or more https], addressBook, relay, checkers:[...], zone, probeZone, stateDir,
//          budget:{monthlyBytes, stopAt}}   (budget: outbound bytes this month; at stopAt the provider stops accepting)
import fs from 'node:fs/promises';
import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {createPublicClient,http} from 'viem';
import {base} from 'viem/chains';
import {LeaseReader} from '../lease-reader.mjs';
import {WgProvider} from './provider.mjs';
import {Kernel} from './kernel.mjs';
import {createRouter} from './router.mjs';
import {createControl} from './control.mjs';
import {providerIdFor,signProviderRecord,eligibleProviders} from '../provider-directory.mjs';

const log=m=>console.log(new Date().toISOString(),m);
const cfg=JSON.parse(await fs.readFile(process.argv[2]||'/etc/enclave-network/provider.json','utf8'));
const account=privateKeyToAccount((await fs.readFile(cfg.operatorKeyFile,'utf8')).trim());
const ports={exit:51820,guard:51821,control:51822,...cfg.ports};
const providerId=providerIdFor(account.address,cfg.publicAddress);
const stateDir=cfg.stateDir||'/var/lib/enclave-network';await fs.mkdir(stateDir,{recursive:true,mode:0o700});
if(!Array.isArray(cfg.rpc)||cfg.rpc.length<2)throw new Error('two or more RPC endpoints required');

const kernel=new Kernel({publicAddress:cfg.publicAddress,uplink:cfg.uplink||'eth0',ports,log});
const keys=await kernel.ensure();
const leases=new LeaseReader({rpc:cfg.rpc,addressBook:cfg.addressBook,includeHostPayout:true});
const clients=cfg.rpc.map(url=>createPublicClient({chain:base,transport:http(url,{timeout:10000})}));
// ERC-1271 (passkey vault) owners: every RPC must agree the signature is valid.
const verifyOwner=async(owner,message,signature)=>{const r=await Promise.all(clients.map(c=>c.verifyMessage({address:owner,message,signature}).catch(()=>false)));return r.every(Boolean);};
const policyFile=path.join(stateDir,'policy-nonces.json');
let nonces={};try{nonces=JSON.parse(await fs.readFile(policyFile,'utf8'));}catch{}
const policyMemory={get:async id=>nonces[id],set:async(id,n)=>{nonces[id]=n;await fs.writeFile(policyFile+'.tmp',JSON.stringify(nonces),{mode:0o600});await fs.rename(policyFile+'.tmp',policyFile);}};
const relayJSON=async p=>{const r=await fetch(cfg.relay+p,{signal:AbortSignal.timeout(10000)});if(r.status===404)return null;if(!r.ok)throw new Error(`relay ${p}: HTTP ${r.status}`);return r.json();};
let domainMap={at:0,map:{}};
const domains=async id=>{if(Date.now()-domainMap.at>60000){try{const m=await relayJSON('/v1/domains/map');domainMap={at:Date.now(),map:m||{}};}catch(e){log(e.message);}}
 return Object.entries(domainMap.map?.domains||domainMap.map||{}).filter(([,v])=>(v?.deploymentId||v)===id).map(([k])=>k.toLowerCase());};
let targetCache={at:0,list:[]};
const targets=async()=>{
 if(Date.now()-targetCache.at<60000)return targetCache.list;
 try{const d=await relayJSON('/v1/network/providers');
  const ok=await eligibleProviders(d?.providers||[],{checkers:cfg.checkers||[],hostOperator:async()=>null});
  targetCache={at:Date.now(),list:ok.filter(p=>p.providerId!==providerId&&p.eligibleRoles.some(r=>r!=='guard')).map(p=>({address:p.address,ports:p.ports}))};
 }catch(e){log('provider directory: '+e.message);}
 return targetCache.list;
};
const config={providerId,roles:cfg.roles,pricePerGiB6:cfg.pricePerGiB6||0,publicAddress:cfg.publicAddress,exitKey:keys['wg-exit'],guardKey:keys['wg-guard'],
 ports,zone:cfg.zone||'app.enclave.host',probeZone:cfg.probeZone||'probe.enclave.host',checkers:cfg.checkers||[]};
const provider=new WgProvider({config,signer:account,kernel,log,policyMemory,verifyOwner,domains,targets,
 leases:async id=>(await leases.readSnapshot([id]))[0]||null,
 currentPolicy:async id=>(await relayJSON('/v1/network/policy/'+id))?.envelope||null});
const meter=new Map();
const count=(to,up,down)=>{const m=meter.get(to)||{up:0,down:0};m.up+=up;m.down+=down;meter.set(to,m);};
const routes=[await createRouter({port:443,route:n=>provider.route(n),tls:true,count,log}),await createRouter({port:80,route:n=>provider.route(n),tls:false,count,log})];
const control=await createControl({provider,port:ports.control,log,info:()=>({providerId,operator:account.address.toLowerCase(),address:cfg.publicAddress,roles:cfg.roles,
 pricePerGiB6:config.pricePerGiB6,keys:{exit:keys['wg-exit'],guard:keys['wg-guard']},ports,region:cfg.region,kind:cfg.kind||'enclave'})});

// The transfer budget: outbound bytes this calendar month (UTC), kept across restarts and counter resets.
const budgetFile=path.join(stateDir,'transfer.json');
let budget;try{budget=JSON.parse(await fs.readFile(budgetFile,'utf8'));}catch{budget={month:'',used:0,last:null};}
async function checkBudget(){
 const month=new Date().toISOString().slice(0,7),{tx}=await kernel.uplinkBytes();
 if(budget.month!==month)budget={month,used:0,last:tx};
 budget.used+=budget.last===null||tx<budget.last?0:tx-budget.last;budget.last=tx;
 await fs.writeFile(budgetFile+'.tmp',JSON.stringify(budget));await fs.rename(budgetFile+'.tmp',budgetFile);
 const stop=cfg.budget?.stopAt??cfg.budget?.monthlyBytes;
 const over=Number.isFinite(stop)&&budget.used>=stop;
 if(over!==!provider.accepting){provider.accepting=!over;log(over?`transfer budget reached (${budget.used} B this month): not accepting peers`:'transfer budget available: accepting peers');}
}
// The opt-in: this provider's signed record, re-published while it runs. Over budget it publishes no roles.
async function publish(){
 const now=Date.now();
 const record={version:1,providerId,operator:account.address.toLowerCase(),address:cfg.publicAddress,wgExitKey:keys['wg-exit'],wgGuardKey:keys['wg-guard'],ports,
  roles:provider.accepting?cfg.roles:[],pricePerGiB6:config.pricePerGiB6,region:cfg.region||'unknown',kind:cfg.kind||'enclave',hostId:cfg.hostId||null,issuedAt:now,expiresAt:now+30*60000};
 const env=await signProviderRecord(account,record);
 const r=await fetch(cfg.relay+'/v1/network/providers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(env),signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw new Error('publish provider record: HTTP '+r.status+' '+(await r.text()).slice(0,200));
}
const every=(ms,f,name)=>{const go=()=>f().catch(e=>log(`${name}: ${e.message}`));setInterval(go,ms).unref?.();return go();};
await every(60000,checkBudget,'budget');
every(30000,()=>provider.sweep(),'sweep');
every(10*60000,publish,'publish');
log(`provider ${providerId} up: ${cfg.publicAddress} roles ${cfg.roles.join(',')} exit ${keys['wg-exit']} guard ${keys['wg-guard']}`);
const stop=()=>{for(const r of routes)r.close();control.close();process.exit(0);};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
