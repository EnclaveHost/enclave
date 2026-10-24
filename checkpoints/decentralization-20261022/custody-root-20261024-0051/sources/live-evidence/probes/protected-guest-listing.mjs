// Root read-only authenticated guestd listing. Persist only public identity/status/digests; never key or guest environment.
import fs from 'node:fs';
import {GuestdControl,parseKey} from '../../linux-post-adoption-release/stage/metal-deabf8f90/isolation/m4/guestd/control-client.mjs';
const dest = process.argv[2]; if(!dest) throw new Error('output path required');
const key=parseKey(fs.readFileSync('/home/steven/enclave-prod/guestd-pair.key','utf8'));
try{
 const client=new GuestdControl('http://127.0.0.1:8095',key,{requestTimeoutMs:12000,maxResponseBytes:1048576});
 const {status,body}=await client.request('GET','/vms');
 if(status!==200||!Array.isArray(body?.vms))throw new Error('guestd listing shape/status mismatch');
 const fields=['id','name','status','recordSha256','createdAt'];
 const out={vms:body.vms.map(r=>Object.fromEntries(fields.filter(k=>k in r).map(k=>[k,r[k]])))};
 fs.writeFileSync(dest,JSON.stringify(out,null,2)+'\n',{mode:0o600});fs.chmodSync(dest,0o600);
 console.log(JSON.stringify({at:new Date().toISOString(),readOnly:true,rows:out.vms.length,output:dest}));
}finally{key.fill(0)}
