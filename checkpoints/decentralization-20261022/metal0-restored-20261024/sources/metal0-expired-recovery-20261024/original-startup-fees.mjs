// Read-only original-control restart budget. This is NOT the candidate cutover gate.
// Executes the original pinned sender through its unchanged fallback transport, with a no-sign account.
import fs from 'node:fs';import {createHash} from 'node:crypto';
import {approvedSender,priceViaSender,PINS,OLD_SENDER,REG,ORACLE,H_REPO} from '../custody-boot-final-recovery-20261024/boot-funding.mjs';
import {l1SizeArgument} from '../custody-boot-final-recovery-20261024/fee-fit.mjs';
const viem=await import(H_REPO+'/node_modules/viem/_esm/index.js'),accounts=await import(H_REPO+'/node_modules/viem/_esm/accounts/index.js'),{base}=await import(H_REPO+'/node_modules/viem/_esm/chains/index.js');
const cfg=fs.readFileSync('/home/steven/Projects/enclave/metal/config.json');if(createHash('sha256').update(cfg).digest('hex')!=='58aa9653586b6e4d67f2198dde111fad0329d2b33770c4f4a4ba14d5ddc220b3')throw Error('original config changed');
const sender=approvedSender(OLD_SENDER.commit,H_REPO,OLD_SENDER.senderSha256);
const urls=[...PINS.pool],transport=viem.fallback(urls.map(u=>viem.http(u,{retryCount:2,retryDelay:500,timeout:15000})));
const clients=urls.slice(0,2).map(u=>viem.createPublicClient({chain:base,transport:viem.http(u,{timeout:15000,retryCount:0})}));
const agree=async fn=>{const r=await Promise.all(clients.map(fn));if(JSON.stringify(r[0],(_,v)=>typeof v==='bigint'?String(v):v)!==JSON.stringify(r[1],(_,v)=>typeof v==='bigint'?String(v):v))throw Error('startup providers disagree');return r[0];};
if(await agree(c=>c.getChainId())!==8453)throw Error('chain');
const balance=await agree(c=>c.getBalance({address:PINS.operator})),nonce=await agree(c=>c.getTransactionCount({address:PINS.operator,blockTag:'latest'}));
if(await agree(c=>c.getTransactionCount({address:PINS.operator,blockTag:'pending'}))!==nonce)throw Error('pending operator transaction');
if((await agree(c=>c.getCode({address:PINS.operator}))).toLowerCase()!=='0xef0100'+PINS.executor.slice(2))throw Error('delegation');
const oracle=(fn,args=[])=>agree(c=>c.readContract({address:PINS.oracle,abi:ORACLE,functionName:fn,args}));
if(await oracle('isIsthmus')!==true)throw Error('operator fee unavailable');
const id=viem.keccak256(viem.stringToBytes(PINS.endpoint)),rows=[];
for(const [functionName,args] of [['register',[PINS.endpoint,PINS.repo,PINS.measurement,PINS.cpu,0n,PINS.testProofKey]],['setPrices',[id,PINS.cpu,PINS.gpu]]]){
 const r=await priceViaSender({senderText:sender.text,viem,accounts,chain:base,transport,operator:PINS.operator,to:PINS.registry,abi:REG,functionName,args});
 const {gas,maxFeePerGas,maxPriorityFeePerGas}=r.prepared;if([gas,maxFeePerGas,maxPriorityFeePerGas].some(v=>typeof v!=='bigint'))throw Error('missing fee fields');
 const tx={type:'eip1559',chainId:8453,nonce:nonce+rows.length,to:PINS.registry,value:0n,data:viem.encodeFunctionData({abi:REG,functionName,args}),gas,maxFeePerGas,maxPriorityFeePerGas};
 const unsigned=(viem.serializeTransaction(tx).length-2)/2,signedMax=(viem.serializeTransaction(tx,{r:'0x'+'ff'.repeat(32),s:'0x'+'ff'.repeat(32),yParity:1}).length-2)/2;
 const l1=await oracle('getL1FeeUpperBound',[BigInt(l1SizeArgument({unsigned,signedMax}))]),operatorFee=await oracle('getOperatorFee',[gas]);
 rows.push({functionName,gas:String(gas),maxFeePerGas:String(maxFeePerGas),l1FeeUpperBoundWei:String(l1),operatorFeeWei:String(operatorFee),worstCaseWei:String(gas*maxFeePerGas+l1+operatorFee)});
}
const total=rows.reduce((a,r)=>a+BigInt(r.worstCaseWei),0n),required=(total*125n+99n)/100n;
const out={at:new Date().toISOString(),readOnly:true,scope:'Original control register + setPrices restart only; not a candidate cutover approval',originalCommit:OLD_SENDER.commit,senderSha256:sender.senderSha256,rpcTransport:'Original viem fallback, unchanged ordered pool',pool:urls,independentFeeAndBalanceReads:urls.slice(0,2),rows,balanceWei:String(balance),requiredWith25PercentHeadroomWei:String(required),fits:balance>=required};
fs.writeFileSync('outputs/decentralization-audit/metal0-original-startup-budget-20261024.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));if(!out.fits)process.exitCode=1;
