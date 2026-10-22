import fs from 'node:fs';
const allowed=new Set(['base-rpc.publicnode.com','base.drpc.org','mainnet.base.org']);
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(url.protocol!=='https:'||!allowed.has(url.hostname))throw Error('reconciliation verification refused non-RPC request: '+url.hostname);
 const body=typeof init?.body==='string'?JSON.parse(init.body):null;
 if(JSON.stringify(body).toLowerCase().includes('ab214342d5a490150a4a977063a2f88e21f80907'))throw Error('address-book request refused, including encoded multicalls');
 const batch=Array.isArray(body)?body:[body];
 for(const request of batch){
  if(request?.method==='eth_call'&&request.params?.[0]?.to?.toLowerCase()==='0xab214342d5a490150a4a977063a2f88e21f80907')throw Error('address-book read refused');
 }
 fs.appendFileSync(process.env.RECONCILE_REQUEST_LOG,JSON.stringify({host:url.hostname,methods:batch.map(r=>r?.method)})+'\n');
 return original(input,init);
};
