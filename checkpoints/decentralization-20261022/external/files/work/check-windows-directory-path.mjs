import fs from 'node:fs/promises';
import {guardedFetch} from './guarded-fetch.mjs';
const root='C:/ProgramData/Enclave/network/state',id='0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33';
const map=JSON.parse(await fs.readFile(root+'/egress-routes.json'));
const pub=JSON.parse(await fs.readFile(root+'/routes/published-'+id+'.json'));
const origins=['http://134.199.235.187:8188','http://134.209.248.172:8188','http://165.245.191.129:8188','http://146.190.246.39:8188'];
for(const [index,proxy] of (map.apps[id]?.proxies||[]).entries()){
 const fetch=guardedFetch(proxy,{timeoutMs:8000,publicRecords:true});
 for(const origin of origins){const began=Date.now();try{
  const r=await fetch(origin+'/v1/network/routes',{method:'POST',signal:AbortSignal.timeout(8000),headers:{'content-type':'application/json'},
   body:JSON.stringify({publication:{version:2,policy:pub.policy,bundle:pub.bundle}})});
  console.log(JSON.stringify({path:index,origin,status:r.status,ms:Date.now()-began,response:(await r.text()).slice(0,300)}));
 }catch(e){console.log(JSON.stringify({path:index,origin,ms:Date.now()-began,error:e.message}));}}
}
