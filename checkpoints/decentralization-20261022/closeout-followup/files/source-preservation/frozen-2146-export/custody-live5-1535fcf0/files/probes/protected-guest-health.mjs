import fs from 'node:fs';
import {GuestdControl,parseKey} from '../../linux-post-adoption-release/stage/metal-deabf8f90/isolation/m4/guestd/control-client.mjs';
const key=parseKey(fs.readFileSync('/home/steven/enclave-prod/guestd-pair.key','utf8')),rows=[];
try{
 const client=new GuestdControl('http://127.0.0.1:8095',key,{requestTimeoutMs:12000,maxResponseBytes:131072});
 for(const id of ['gd9d4a391d','gdd0646f2c']){const {status,body}=await client.request('GET','/vms/'+id);rows.push({id,status,guest:body&&Object.fromEntries(Object.entries(body).filter(([k])=>['id','status','name','runtimeId'].includes(k)))});}
 const out={at:new Date().toISOString(),readOnly:true,rows}; const text=JSON.stringify(out,null,2);fs.writeFileSync(new URL('../evidence/protected-guest-health.json',import.meta.url),text+'\n');console.log(text);
}finally{key.fill(0)}
