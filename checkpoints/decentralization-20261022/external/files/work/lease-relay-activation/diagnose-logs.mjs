import {clientsFor} from '../lease-gas-wallet-signing/rpc-clients.mjs';
import {ENROLLMENT} from '../lease-enrollment-signing/trust.mjs';
const urls=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base-mainnet.public.blastapi.io'];
const cs=clientsFor(urls);const all=await Promise.allSettled(cs.map(c=>c.request({method:'eth_getLogs',params:[{address:ENROLLMENT.reserve,fromBlock:'0x'+(52875724).toString(16),toBlock:'0x'+(52875894).toString(16)}]})));
for(let i=0;i<all.length;i++){const r=all[i];console.log(JSON.stringify({url:urls[i],status:r.status,...(r.status==='fulfilled'?{count:r.value.length,keys:r.value[0]?Object.keys(r.value[0]):[],first:r.value[0]}:{error:r.reason.message.slice(0,1500)})}));}
