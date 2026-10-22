import fs from 'node:fs';
import {createPublicClient,http} from '../enclave/node_modules/viem/_esm/index.js';
import {readServiceIndex,publicIPv4} from '../enclave/network/service-index.mjs';
import {DirectoryClient} from '../enclave/network/directory-client.mjs';
const pin=JSON.parse(fs.readFileSync('outputs/service-index/pin.json'));
const operator='0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab';
const originalFetch=globalThis.fetch,seen=new Set();let forbidden=0;
const guarded=(input,init)=>{
 const u=new URL(typeof input==='string'?input:input.url||input);
 if(u.hostname==='62.238.4.214'||u.hostname==='enclave.host'||u.hostname.endsWith('.enclave.host')||String(init?.body||'').toLowerCase().includes('ab214342d5a490150a4a977063a2f88e21f80907')){forbidden++;throw Error('Enclave origin, Nan and mutable address book denied by proof guard');}
 seen.add(u.origin);return originalFetch(input,init);
};
globalThis.fetch=guarded;
try{guarded('https://api.enclave.host/positive-control');throw Error('guard failed');}catch(e){if(!e.message.includes('denied by proof guard'))throw e;}
forbidden=0;
const urls=['https://base-rpc.publicnode.com','https://base.drpc.org','https://base.public.blockpi.network/v1/rpc/public','https://mainnet.base.org'];
const peers=urls.map(url=>({label:new URL(url).origin,client:createPublicClient({transport:http(url,{fetchFn:guarded,retryCount:0,timeout:8000})})}));
// The operator slot was explicitly chosen for this rehearsal. No listing order or Enclave API selects an operator.
const index=await readServiceIndex({peers,pin,kinds:[],lookups:[{operator,slot:0}]});
const lookup=index.lookups.find(r=>r.operator===operator&&r.slot===0);
const candidate=lookup?.candidate;
if(lookup?.state!=='listed'||candidate?.kindName!=='directory')throw Error('operator directory advertisement unavailable');
const origins=candidate.endpoints.map(raw=>{const u=new URL(raw);if(!publicIPv4(u.hostname)||u.pathname!=='/'||u.search||u.hash)throw Error('rehearsal only accepts reviewed public literal-IP directory origins');return u.origin;});
const dc=new DirectoryClient({origins,fetch:guarded});
const providers=await dc.providers();
if(!providers.providers.length)throw Error('no fresh operator-signed provider records verified');
if(forbidden)throw Error('unexpected forbidden dependency attempted');
const out={at:new Date().toISOString(),coldState:true,indexPin:pin,explicitlySelectedOperator:operator,lookupBlock:index.blockNumber,lookupBlockHash:index.blockHash,discoveredDirectoryOrigins:origins,verifiedSignedProviderCount:providers.providers.length,providerIds:providers.providers.map(p=>p.record.record.providerId),contactedOrigins:[...seen],unexpectedForbiddenAttempts:forbidden,guardPositiveControlPassed:true,limits:'Cold discovery and operator-signature validation only. No lease admission, checker eligibility, independent organization, whole-host recovery or full Enclave-refusal claim. All advertised directories remain Enclave-operated.'};
fs.writeFileSync('outputs/service-index/cold-discovery.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
