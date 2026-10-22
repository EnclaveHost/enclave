import fs from 'node:fs';
import {createPublicClient,http} from '../enclave/node_modules/viem/_esm/index.js';
const dir='work/root-lease-spend-audit-20261022', prior=JSON.parse(fs.readFileSync(dir+'/raw.json')), a=prior.reads.find(x=>!x.error), end=BigInt(prior.end), start=end-9000n;
const norm=l=>({blockNumber:String(l.blockNumber),blockHash:l.blockHash,transactionHash:l.transactionHash,logIndex:Number(l.logIndex),data:l.data,topics:l.topics});
const expected=a.logs.filter(l=>BigInt(l.blockNumber)>=start).map(norm);
const out={at:new Date().toISOString(),fromBlock:String(start),toBlock:String(end),historicalProvider:a.url,expectedEvents:expected.length,reads:[]};
for(const url of ['https://base.drpc.org','https://base-rpc.publicnode.com']){
 try{const c=createPublicClient({transport:http(url,{timeout:15000,retryCount:0})}); if(await c.getChainId()!==8453)throw Error('chain');
 const logs=await c.getLogs({address:'0x12A3f873041Dec436DaA0085B766a399A6fA3639',fromBlock:start,toBlock:end});const block=await c.getBlock({blockNumber:end});
 out.reads.push({url,events:logs.length,match:JSON.stringify(logs.map(norm))===JSON.stringify(expected),blockHashMatches:block.hash===a.blockHash});
 }catch(e){out.reads.push({url,error:String(e.shortMessage||e.message)+' '+String(e.details||'')});}
}
fs.writeFileSync(dir+'/recent-corroboration.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
