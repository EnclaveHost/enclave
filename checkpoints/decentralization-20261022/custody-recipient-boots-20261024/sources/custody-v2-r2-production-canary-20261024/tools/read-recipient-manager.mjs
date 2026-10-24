// Read-only authentication smoke check. Never emits peer errors, pairing material or VM response bodies.
import fs from 'node:fs';import {checkRepo} from '../driver/cli.mjs';import {loadRecipientClient} from '../driver/recipient-client.mjs';
const pins=JSON.parse(fs.readFileSync(new URL('../pins.base.json',import.meta.url),'utf8'));let client;
try{
 checkRepo(pins);client=await loadRecipientClient(pins);const r=await client.get('/vms');
 if(r.status!==200||!Array.isArray(r.body?.vms)||!/^[a-f0-9]{32}$/.test(client.instance))throw Error('invalid authenticated metadata');
 const ids=['gd9d4a391d','gdd0646f2c'];
 console.log(JSON.stringify({at:new Date().toISOString(),readOnly:true,authenticated:true,vmCount:r.body.vms.length,
  originals:ids.map(id=>({id,present:r.body.vms.some(v=>v.id===id),running:r.body.vms.some(v=>v.id===id&&v.status==='running')})),
  scope:'Authenticated local guestd metadata only; no canary boot, SNP quote or secret-release test.'},null,2));
}catch{console.error('Recipient manager observation failed; no authentication or readiness inferred.');process.exitCode=1;}finally{client?.close();}
