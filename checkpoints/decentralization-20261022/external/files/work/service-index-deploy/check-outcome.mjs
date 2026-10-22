import fs from 'node:fs';
import {createPublicClient,http} from '../enclave/node_modules/viem/_esm/index.js';
const j=JSON.parse(fs.readFileSync('work/service-index-deploy/journal.json')),op=j.operations.deploy;
const rows=await Promise.all(['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base.drpc.org','https://base.public.blockpi.network/v1/rpc/public'].map(async url=>{
 const c=createPublicClient({transport:http(url,{timeout:12000,retryCount:0})});
 const r={rpc:url,hash:op.hash};for(const[k,fn]of Object.entries({receipt:()=>c.getTransactionReceipt({hash:op.hash}),transaction:()=>c.getTransaction({hash:op.hash}),nonce:()=>c.getTransactionCount({address:j.deployer,blockTag:'pending'}),code:()=>c.getCode({address:j.target}),balance:()=>c.getBalance({address:j.deployer})}))try{const x=await fn();r[k]=k==='receipt'?{status:x.status,blockNumber:String(x.blockNumber),contractAddress:x.contractAddress}:k==='transaction'?{hash:x.hash,blockNumber:String(x.blockNumber),nonce:x.nonce}:k==='code'?{bytes:x?(x.length-2)/2:0}:String(x);}catch(e){r[k]={error:e.name,details:e.shortMessage||'RPC error'};}return r;
}));fs.writeFileSync('work/service-index-deploy/outcome-check.json',JSON.stringify(rows,null,2)+'\n');console.log(JSON.stringify(rows,null,2));
