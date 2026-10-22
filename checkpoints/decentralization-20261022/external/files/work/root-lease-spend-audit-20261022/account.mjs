import fs from 'node:fs';
import {createPublicClient,http,keccak256,parseAbiItem,decodeEventLog,formatEther} from '../enclave/node_modules/viem/_esm/index.js';
import {base} from '../enclave/node_modules/viem/_esm/chains/index.js';
import {RESERVE_ABI} from '../enclave/client/lease-executor-client.mjs';
import {OWNER_ABI,LEDGER_ABI} from '../enclave/network/lease-gas-owner.mjs';
const dir='work/root-lease-spend-audit-20261022';
const dep=JSON.parse(fs.readFileSync('outputs/app-lease-gas-review/lease-gas-deployment.json'));
const labels=JSON.parse(fs.readFileSync('work/ens-outage-20261022/batch-labels.json')).rows;
labels.push({id:'0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33',slug:'s3-ipfs-adapter'});
const prior=JSON.parse(fs.readFileSync(dir+'/raw.json')),agreeing=prior.reads.filter(x=>!x.error),start=prior.start,end=prior.end;
const str=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
const r=agreeing[0],abi=[...RESERVE_ABI,parseAbiItem('event Deposited(bytes32 indexed id, address indexed owner, address indexed from, uint256 amountWei)'),parseAbiItem('event Withdrawn(bytes32 indexed id, address indexed owner, address to, uint256 amountWei)')];
const events=r.logs.flatMap(l=>{try{const e=decodeEventLog({abi,data:l.data,topics:l.topics,strict:true});return[{...l,...e}]}catch{return[]}});
const rows=r.reserves.map(rv=>{
 const ev=events.filter(e=>e.args.id===rv.id&&e.args.owner?.toLowerCase()===rv.owner.toLowerCase());
 const sum=(name,key)=>ev.filter(e=>e.eventName===name).reduce((n,e)=>n+BigInt(e.args[key]),0n);
 const paid=ev.filter(e=>e.eventName==='LeaseGasPaid'),deposited=sum('Deposited','amountWei'),withdrawn=sum('Withdrawn','amountWei'),charged=sum('LeaseGasPaid','chargedWei');
 const byKind={};for(const[k,n]of[[1,'claim'],[2,'renew'],[3,'release']]){const x=paid.filter(e=>Number(e.args.kind)===k),total=x.reduce((a,e)=>a+e.args.chargedWei,0n);byKind[n]={count:x.length,totalWei:total,totalETH:formatEther(total),meanWei:x.length?total/BigInt(x.length):0n};}
 const renew=paid.filter(e=>Number(e.args.kind)===2),intervals=renew.slice(1).map((e,i)=>Number(e.blockNumber-renew[i].blockNumber)*2).sort((a,b)=>a-b);
 return{slug:labels.find(l=>l.id===rv.id).slug,...rv,depositedWei:deposited,depositedETH:formatEther(deposited),withdrawnWei:withdrawn,chargedWei:charged,chargedETH:formatEther(charged),remainingETH:formatEther(rv.balance),reconciles:deposited-withdrawn-charged===BigInt(rv.balance),byKind,renewIntervalSecondsApprox:{method:'Base block difference times2; receipt timestamps not individually fetched',min:intervals[0]??null,median:intervals[Math.floor(intervals.length/2)]??null,max:intervals.at(-1)??null},firstDepositBlock:ev.find(e=>e.eventName==='Deposited')?.blockNumber,lastPaidBlock:paid.at(-1)?.blockNumber};
});
const out={at:new Date().toISOString(),start,end,blockHash:r.blockHash,fullHistoryProviders:agreeing.map(x=>x.url),fullHistoryQuorum:false,events:events.length,allBalancesReconcile:rows.every(x=>x.reconciles),rows,scope:'All reserve deposits, withdrawals and successful paid lease operations since before reserve deployment. Does not by itself audit failed transactions paid by relays or unrelated registry/status transactions.'};
fs.writeFileSync(dir+'/accounting.json',str(out)+'\n');console.log(str(out));if(!out.allBalancesReconcile)process.exitCode=2;
