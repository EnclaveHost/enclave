// Read-only production recovery evidence. No signer or send method is created.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {decodeFunctionData, decodeEventLog} from '../enclave/node_modules/viem/_esm/index.js';
import {leaseRpcSet,verifiedLeaseAuthority} from '../enclave/client/lease-executor-authority.mjs';
import {verifyLeaseReceipt,EXECUTOR_ABI,RESERVE_ABI} from '../enclave/client/lease-executor-client.mjs';
import {clientsFor} from '../lease-gas-wallet-signing/rpc-clients.mjs';
import {ENROLLMENT} from '../lease-enrollment-signing/trust.mjs';
const output=new URL('../../outputs/app-lease-gas-review/live-paid-leases-latest.json',import.meta.url);
const raw=fs.readFileSync(new URL('./deployment.json',import.meta.url));
if(createHash('sha256').update(raw).digest('hex')!=='1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089')throw Error('reviewed record changed');
const deployment=JSON.parse(raw),journals=[];
for(let i=1;i<=25;i++){
 const j=JSON.parse(fs.readFileSync(new URL('../lease-enrollment-signing/journals/op-'+String(i).padStart(2,'0')+'.json',import.meta.url)));
 if(j.status!=='confirmed'||j.planSha256!=='6e1b0bfb10a0d502921215e0624885406a0f2805e45bc2d4934a8d9e63e609f2')throw Error('funding not all confirmed');journals.push(j);
}
const clients=clientsFor(['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base-mainnet.public.blastapi.io']);
const rpc=leaseRpcSet(clients,{quorum:2,timeoutMs:60000});
const {pins,block}=await verifiedLeaseAuthority({clients,deployment,quorum:2,timeoutMs:60000});
const fundingBlock=BigInt(journals[24].verification.minedBlock),last=block.number;
if(last<fundingBlock)throw Error('RPC block predates funding');
// A bounded recent window. The original all-nine claim audit is retained separately.
const first=last-fundingBlock>4999n?last-4999n:fundingBlock;
const logs=[],discovery=[];
for(let start=first;start<=last;start+=500n){
 const end=start+499n<last?start+499n:last;
 // Discovery is an untrusted hint only. Every candidate below needs quorum verification
 // of canonical transaction, receipt, code, charge and ledger state. No absence proof.
 const results=await Promise.allSettled(rpc.peers.map(p=>rpc.request(p.client,'eth_getLogs',[{address:pins.reserve,fromBlock:'0x'+start.toString(16),toBlock:'0x'+end.toString(16)}])));
 discovery.push({fromBlock:start,toBlock:end,providers:results.map((r,i)=>({index:i,status:r.status,count:r.status==='fulfilled'?r.value.length:undefined,error:r.status==='rejected'?String(r.reason.message).slice(0,180):undefined}))});
 for(const r of results)if(r.status==='fulfilled')logs.push(...r.value);
 if(!results.some(r=>r.status==='fulfilled'))throw Error('no log discovery provider available');
}
const appIds=new Set(ENROLLMENT.apps.map(x=>x[0])),payees=ENROLLMENT.relays.map(x=>x[1]),evidence=[];
const seen=new Set();
for(const log of logs){
 if(seen.has(log.transactionHash+":"+log.logIndex))continue;seen.add(log.transactionHash+":"+log.logIndex);
 let ev;try{ev=decodeEventLog({abi:RESERVE_ABI,topics:log.topics,data:log.data});}catch{continue;}
 if(ev.eventName!=='LeaseGasPaid'||!appIds.has(ev.args.id))continue;
 const {value:tx}=await rpc.agree(rpc.peers,p=>p.client.getTransaction({hash:log.transactionHash}),'lease transaction');
 const call=decodeFunctionData({abi:EXECUTOR_ABI,data:tx.input});
 if(call.functionName!=='lease')throw Error('not a lease');
 const want=call.args[0];
 if(want.id!==ev.args.id||Number(want.kind)!==Number(ev.args.kind)||!payees.includes(tx.from.toLowerCase()))throw Error('payer or lease differs');
 const checked=await verifyLeaseReceipt({rpc,pins,operator:ev.args.operator,hash:log.transactionHash,want:{...want,kind:Number(want.kind)},payees});
 if(checked.chargedWei<=0n)throw Error('no app reserve charge');
 evidence.push({deployment:want.id,kind:Number(want.kind),operator:ev.args.operator,relay:checked.payee,transactionHash:checked.hash,blockNumber:checked.blockNumber,chargedWei:checked.chargedWei});
}
const affected=['a77d0c57','a69dcbba','38f368d6','59f1273d','7ae476a3','ef514ed3','e64f7cba','d9798e4c','c13d4b6a'];
const apps=affected.map(prefix=>({prefix,claim:evidence.some(e=>e.deployment.startsWith('0x'+prefix)&&e.kind===1),renewal:evidence.some(e=>e.deployment.startsWith('0x'+prefix)&&e.kind===2)}));
const report={at:new Date().toISOString(),status:'chain payment evidence only; runtime/application health is checked separately',quorum:2,discoveryIsUntrusted:true,absenceProven:false,discovery,fundingBlock,fromBlock:first,toBlock:last,fullHistorySinceFunding:first===fundingBlock,initialClaimEvidence:"live-paid-leases.json",reserve:pins.reserve,enrollmentConfirmed:25,events:evidence,queuedApps:apps,allNineClaimed:apps.every(x=>x.claim),allNineRenewed:apps.every(x=>x.renewal)};
const text=JSON.stringify(report,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';fs.writeFileSync(output,text);console.log(text);
