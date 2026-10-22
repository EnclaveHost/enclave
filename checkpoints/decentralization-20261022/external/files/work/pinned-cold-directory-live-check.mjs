import fs from 'node:fs/promises';
import {runDirectory} from './enclave/network/directory-server.mjs';
const origins=['http://134.199.235.187:8188','http://134.209.248.172:8188','http://165.245.191.129:8188','http://146.190.246.39:8188'];
const authorityObservation=JSON.parse(await fs.readFile(new URL('../outputs/network-authority-observation.json',import.meta.url),'utf8'));
const realFetch=globalThis.fetch,seen=new Set();let blocked=0;let blockedBook=0;
globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input.url||input);seen.add(u.origin);if(typeof init?.body==='string'&&init.body.toLowerCase().includes('ab214342d5a490150a4a977063a2f88e21f80907')){blockedBook++;throw Error('address book blocked for pinned metadata test');}if(u.hostname==='62.238.4.214'||u.hostname==='enclave.host'||u.hostname.endsWith('.enclave.host')){blocked++;throw Error('nan/enclave.host blocked for cold metadata test');}return realFetch(input,init);};
const publicInfo=await (await fetch(origins[0]+'/v1/network/providers')).json();
const stateDir=await fs.mkdtemp(new URL('./cold-directory-',import.meta.url).pathname);
const running=await runDirectory({stateDir,bind:'127.0.0.1',port:19989,authorityPins:authorityObservation.authorityPins,rpc:['https://base-rpc.publicnode.com','https://base.drpc.org','https://mainnet.base.org'],addressBook:'0xab214342d5A490150A4A977063A2f88E21F80907',checkers:publicInfo.checkers,peers:origins});
try{
 const end=Date.now()+120000;let result;
 while(Date.now()<end){
  const s=await running.directory.snapshot();
  if(s.providers.length===4&&s.publications.length>=12&&s.policies.length>=5){const routes=await running.directory.routes();if(Object.keys(routes.deployments||{}).length<12)continue;result={verifiedAt:new Date().toISOString(),coldState:true,providers:s.providers.length,policies:s.policies.length,verifiedLiveRoutes:Object.keys(routes.deployments).length,blockedFetchAttempts:blocked,blockedAddressBookAttempts:blockedBook,authorityPins:authorityObservation.authorityPins,origins:[...seen],limitation:'Signed record and lease validation only; no current-policy revision anchor or whole-host outage acceptance.'};break;}
  await new Promise(r=>setTimeout(r,1000));
 }
 if(!result)throw Error('cold directory did not validate required live records before deadline');
 await fs.writeFile(new URL('../outputs/pinned-cold-directory-verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{running.close();}
