import fs from 'node:fs';
import {createPublicClient,http,keccak256,parseAbiItem,decodeEventLog,formatEther} from '../enclave/node_modules/viem/_esm/index.js';
import {base} from '../enclave/node_modules/viem/_esm/chains/index.js';
import {RESERVE_ABI} from '../enclave/client/lease-executor-client.mjs';
import {OWNER_ABI,LEDGER_ABI} from '../enclave/network/lease-gas-owner.mjs';
const dir='work/root-lease-spend-audit-20261022';
const dep=JSON.parse(fs.readFileSync('outputs/app-lease-gas-review/lease-gas-deployment.json'));
const labels=JSON.parse(fs.readFileSync('work/ens-outage-20261022/batch-labels.json')).rows;
labels.push({id:'0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33',slug:'s3-ipfs-adapter'});
const urls=['https://mainnet.base.org','https://base-rpc.polkachu.com','https://base-rpc.publicnode.com'];
const cs=urls.map(url=>createPublicClient({chain:base,transport:http(url,{timeout:12000,retryCount:0})}));
const heads=await Promise.allSettled(cs.map(async c=>{if(await c.getChainId()!==8453)throw Error('wrong chain');return c.getBlockNumber()}));
const good=heads.flatMap((r,i)=>r.status==='fulfilled'?[{i,n:r.value}]:[]);if(good.length<2)throw Error('need two RPCs');
const end=good.reduce((m,x)=>x.n<m?x.n:m,good[0].n)-2n, start=52869000n;
const str=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
const reads=await Promise.all(good.map(async({i})=>{
 try{
  const c=cs[i],block=await c.getBlock({blockNumber:end});if(keccak256(await c.getCode({address:dep.reserve,blockNumber:end}))!==dep.reserveCodeHash)throw Error('runtime changed');
  const logs=[];for(let a=start;a<=end;a+=5000n){const b=a+4999n<end?a+4999n:end;logs.push(...await c.getLogs({address:dep.reserve,fromBlock:a,toBlock:b}));if(logs.length>15000)throw Error('log bound');}
  const deployments=await c.multicall({blockNumber:end,allowFailure:false,contracts:labels.map(({id})=>({address:dep.ledger,abi:LEDGER_ABI,functionName:'get',args:[id]}))});
  const reserves=await c.multicall({blockNumber:end,allowFailure:false,contracts:labels.map(({id},j)=>({address:dep.reserve,abi:OWNER_ABI,functionName:'reserveOf',args:[id,deployments[j].owner]}))});
  return {url:urls[i],blockHash:block.hash,timestamp:block.timestamp,logs:logs.map(l=>({blockNumber:l.blockNumber,blockHash:l.blockHash,transactionHash:l.transactionHash,logIndex:l.logIndex,data:l.data,topics:l.topics})),reserves:reserves.map((r,j)=>({id:labels[j].id,owner:deployments[j].owner,balance:r.balanceWei,renewWindow:r.renewWindow,minExtension:r.minExtension}))};
 }catch(e){return{url:urls[i],error:String(e.shortMessage||e.message).slice(0,250)}}
}));
fs.writeFileSync(dir+'/raw.json',str({at:new Date().toISOString(),start,end,reads})+'\n');
const groups=new Map();for(const r of reads){if(r.error)continue;const{url,...v}=r,key=str(v);groups.set(key,[...(groups.get(key)||[]),r]);}
const agreeing=[...groups.values()].sort((a,b)=>b.length-a.length)[0];if(!agreeing||agreeing.length<2)throw Error('log/current balance quorum unavailable: '+str(reads.map(({url,error})=>({url,error}))));
const r=agreeing[0],abi=[...RESERVE_ABI,parseAbiItem('event Deposited(bytes32 indexed id, address indexed owner, address indexed from, uint256 amountWei)'),parseAbiItem('event Withdrawn(bytes32 indexed id, address indexed owner, address to, uint256 amountWei)')];
const events=r.logs.flatMap(l=>{try{const e=decodeEventLog({abi,data:l.data,topics:l.topics,strict:true});return[{...l,...e}]}catch{return[]}});
const rows=r.reserves.map(rv=>{
 const ev=events.filter(e=>e.args.id===rv.id&&e.args.owner?.toLowerCase()===rv.owner.toLowerCase());
 const sum=(name,key)=>ev.filter(e=>e.eventName===name).reduce((n,e)=>n+BigInt(e.args[key]),0n);
 const paid=ev.filter(e=>e.eventName==='LeaseGasPaid'),deposited=sum('Deposited','amountWei'),withdrawn=sum('Withdrawn','amountWei'),charged=sum('LeaseGasPaid','chargedWei');
 const byKind={};for(const[k,n]of[[1,'claim'],[2,'renew'],[3,'release']]){const x=paid.filter(e=>Number(e.args.kind)===k),total=x.reduce((a,e)=>a+e.args.chargedWei,0n);byKind[n]={count:x.length,totalWei:total,totalETH:formatEther(total),meanWei:x.length?total/BigInt(x.length):0n};}
 const renew=paid.filter(e=>Number(e.args.kind)===2),intervals=renew.slice(1).map((e,i)=>Number(e.blockNumber-renew[i].blockNumber)*2).sort((a,b)=>a-b);
 return{slug:labels.find(l=>l.id===rv.id).slug,...rv,depositedWei:deposited,depositedETH:formatEther(deposited),withdrawnWei:withdrawn,chargedWei:charged,chargedETH:formatEther(charged),remainingETH:formatEther(rv.balance),reconciles:deposited-withdrawn-charged===rv.balance,byKind,renewIntervalSecondsApprox:{method:'Base block difference times2; receipt timestamps not individually fetched',min:intervals[0]??null,median:intervals[Math.floor(intervals.length/2)]??null,max:intervals.at(-1)??null},firstDepositBlock:ev.find(e=>e.eventName==='Deposited')?.blockNumber,lastPaidBlock:paid.at(-1)?.blockNumber};
});
const out={at:new Date().toISOString(),start,end,blockHash:r.blockHash,agreeing:agreeing.map(x=>x.url),events:events.length,allBalancesReconcile:rows.every(x=>x.reconciles),rows,scope:'All reserve deposits, withdrawals and successful paid lease operations since before reserve deployment. Does not by itself audit failed transactions paid by relays or unrelated registry/status transactions.'};
fs.writeFileSync(dir+'/summary.json',str(out)+'\n');console.log(str(out));if(!out.allBalancesReconcile)process.exitCode=2;
