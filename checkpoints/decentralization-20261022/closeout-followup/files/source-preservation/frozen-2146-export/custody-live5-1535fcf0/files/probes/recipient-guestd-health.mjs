// Authenticated GET only through the existing production control client. Pairing key stays in memory, never output.
import fs from 'node:fs';
import {GuestdControl,parseKey} from '../../linux-post-adoption-release/stage/metal-deabf8f90/isolation/m4/guestd/control-client.mjs';
const key=parseKey(fs.readFileSync('/home/steven/enclave-prod/guestd-pair.key','utf8'));
try {
 const client=new GuestdControl('http://127.0.0.1:8095',key,{requestTimeoutMs:12000,maxResponseBytes:131072});
 const {status,body}=await client.request('GET','/health');
 if(status!==200)throw Error('guestd health HTTP '+status);
 const out={at:new Date().toISOString(),readOnly:true,authenticatedResponse:true,status,fields:Object.keys(body),supports:body.supports,catalog:body.catalog&&Object.fromEntries(Object.entries(body.catalog).filter(([k])=>['runtimeId','runtime','release'].includes(k))),limits:['Authenticated host-side capability observation, not guest attestation or a custody release. No key/session material or full response emitted.']};
 fs.writeFileSync(new URL('../evidence/recipient-guestd-health.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
} finally {key.fill(0);}
