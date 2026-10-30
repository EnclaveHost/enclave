import fs from 'node:fs';
import {QuorumChain} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/cli/independent.mjs';
import {OWNER_ABI,LEDGER_ABI} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/network/lease-gas-owner.mjs';
const id='0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238';
const reserve='0x12A3f873041Dec436DaA0085B766a399A6fA3639';
const q=new QuorumChain({rpcs:['https://base-rpc.publicnode.com','https://api.enclave.host/rpc/base','https://base.drpc.org'],quorum:2,timeoutMs:10000});
const event={type:'event',name:'Deposited',inputs:[{name:'id',type:'bytes32',indexed:true},{name:'owner',type:'address',indexed:true},{name:'from',type:'address',indexed:true},{name:'amountWei',type:'uint256',indexed:false}]};
const out={capturedAt:new Date().toISOString(),readOnly:true,scope:'Exact sia-s3 reserve Deposited events since block53256000; canonical quorum, not finality; no signatures or submissions.'};
try {
 out.funding=await q.snapshot(async(c,blockNumber)=>{
  const fromBlock=53256000n;
  if(blockNumber-fromBlock>2400n)throw Error('reviewed search window exceeded');
  const logs=[];
  for(let from=fromBlock;from<=blockNumber;from+=400n){
   const to=from+399n<blockNumber?from+399n:blockNumber;
   logs.push(...await c.getLogs({address:reserve,event,args:{id},fromBlock:from,toBlock:to,strict:true}));
   if(logs.length>8)throw Error('unexpected funding event count');
  }
  const events=[];
  for(const l of logs){
   const [tx,r,b]=await Promise.all([c.getTransaction({hash:l.transactionHash}),c.getTransactionReceipt({hash:l.transactionHash}),c.getBlock({blockNumber:l.blockNumber})]);
   if(r.blockHash!==l.blockHash||b.hash!==l.blockHash||tx.blockHash!==l.blockHash)throw Error('funding receipt canonical identity mismatch');
   const transfers=r.logs.filter(x=>x.topics[0]==='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'&&x.topics.length===3).map(x=>({token:x.address,from:'0x'+x.topics[1].slice(-40),to:'0x'+x.topics[2].slice(-40),amount:BigInt(x.data)}));
   events.push({transactionHash:l.transactionHash,blockNumber:l.blockNumber,blockHash:l.blockHash,timestamp:b.timestamp,status:r.status,deposit:l.args,transaction:{from:tx.from,to:tx.to,valueWei:tx.value,selector:tx.input.slice(0,10)},gasUsed:r.gasUsed,effectiveGasPrice:r.effectiveGasPrice,tokenTransfers:transfers});
  }
  const d=await c.readContract({address:'0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B',abi:LEDGER_ABI,functionName:'get',args:[id],blockNumber});
  const balance=await c.readContract({address:reserve,abi:OWNER_ABI,functionName:'reserveOf',args:[id,d.owner],blockNumber});
  const head=await c.getBlock({blockNumber});
  return {fromBlock,toBlock:blockNumber,events,deployment:{id,owner:d.owner,active:d.active,runner:d.runner,runnerOperator:d.runnerOperator,leaseUntil:d.leaseUntil,leaseLive:d.active&&d.leaseUntil>head.timestamp,rate:d.rate,computeBalance6:d.balance6,reserveWei:balance.balanceWei}};
 });
}catch(e){out.fundingError={message:e.message,failures:e.failures??null};}
try {
 const r=await fetch('https://ef514ed3.app.enclave.host/',{method:'GET',redirect:'manual',signal:AbortSignal.timeout(10000)});
 out.endpoint={url:'https://ef514ed3.app.enclave.host/',status:r.status,contentType:r.headers.get('content-type'),location:r.headers.get('location'),server:r.headers.get('server')};
 await r.body?.cancel();
}catch(e){out.endpoint={error:e.message,code:e.cause?.code??null};}
const text=JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2);
fs.writeFileSync(new URL('./result.json',import.meta.url),text+'\n');console.log(text);
