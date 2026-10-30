import fs from 'node:fs';
import {createPublicClient,http,keccak256} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-kvm-guest/node_modules/viem/_esm/index.js';
import {BIRTH_HINTS} from '../wallet-release-prod-root-repaired-r3/candidate/enclave/site/js/core/wallet-release-census.js';
const h=BIRTH_HINTS.ledger,out={at:new Date().toISOString(),readOnly:true,providers:[]};
for(const url of ['https://api.enclave.host/rpc/base','https://base-mainnet.public.blastapi.io','https://rpc.baseazul.dev']){
 const c=createPublicClient({transport:http(url,{timeout:8000,retryCount:0})}),p={url};out.providers.push(p);
 try{if(await c.getChainId()!==8453)throw Error('chain');const b=await c.getBlock({blockNumber:h.block});if(b.hash!==h.blockHash)throw Error('anchor');const index=b.transactions.indexOf(h.txHash);if(index<0)throw Error('membership');p.index=index;
 const t=await c.request({method:'eth_getTransactionByBlockHashAndIndex',params:[h.blockHash,'0x'+index.toString(16)]});
 if(!t)throw Error('null indexed transaction');if(t.hash!==h.txHash||t.blockHash!==h.blockHash||BigInt(t.blockNumber)!==h.block||BigInt(t.transactionIndex)!==BigInt(index))throw Error('indexed identity mismatch');
 p.transaction={hash:t.hash,blockHash:t.blockHash,blockNumber:t.blockNumber,transactionIndex:t.transactionIndex,to:t.to,from:t.from,inputHash:keccak256(t.input),inputBytes:(t.input.length-2)/2};
 if((await c.getBlock({blockNumber:h.block})).hash!==h.blockHash)throw Error('anchor changed');p.verified=true;
 }catch(e){p.error=String(e.shortMessage||e.message).slice(0,300);}
}
fs.writeFileSync(new URL('./result.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
