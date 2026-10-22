import fs from 'node:fs';
import {DNS} from '../enclavedns-stale-20261021/wallet-handoff/trust.mjs';
import {buildHandoffPlan} from '../enclavedns-stale-20261021/wallet-handoff/handoff-plan.mjs';
import {verifyTx} from '../enclavedns-stale-20261021/wallet-handoff/chain.mjs';
import {clientsFor} from '../lease-gas-wallet-signing/rpc-clients.mjs';
const j=JSON.parse(fs.readFileSync(new URL('../enclavedns-stale-20261021/wallet-handoff/journals/publish.json',import.meta.url)));
const cs=clientsFor(DNS.receiptRpcs), c=cs[1], nonce=1141;
let lo=BigInt(j.attempts.at(-1).anchor.blockNumber),hi=await c.getBlockNumber();
console.log(JSON.stringify({lo:String(lo),hi:String(hi),latest:await c.getTransactionCount({address:DNS.admin})}));
while(lo<hi){const mid=(lo+hi)/2n;const n=await c.getTransactionCount({address:DNS.admin,blockNumber:mid});if(n>nonce)hi=mid;else lo=mid+1n;}
const b=await c.getBlock({blockNumber:lo,includeTransactions:true});
const tx=b.transactions.find(x=>x.from.toLowerCase()===DNS.admin.toLowerCase()&&x.nonce===nonce);
if(!tx)throw Error('nonce transaction not found');
const found={hash:tx.hash,block:String(lo),nonce:tx.nonce,to:tx.to,value:String(tx.value)};
fs.writeFileSync(new URL('nonce1141-found.json',import.meta.url),JSON.stringify(found,null,2));console.log(JSON.stringify(found));
try{const result=await verifyTx({t:DNS,plan:buildHandoffPlan(DNS).plan,step:'publish',attempts:j.attempts,hash:tx.hash,clients:cs});fs.writeFileSync(new URL('nonce1141-verified.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify({outcome:result.outcome,hash:result.transactionHash,providers:result.providers}));}catch(e){console.log(JSON.stringify({error:e.message,halt:e.halt}));process.exitCode=1;}
