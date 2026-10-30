import fs from 'node:fs';
const tx='0x02fcaf17c60f3890252202d4f66f39712fe453955dd1a992ebefef4e23f8c437',height=53272106n;
const results=[];
for(const url of ['https://api.enclave.host/rpc/base','https://rpc.baseazul.dev']){
 const row={url};results.push(row);let seq=0;
 async function rpc(method,params){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method,params}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();if(j.error)throw Error(j.error.message);return j.result;}
 try{if(BigInt(await rpc('eth_chainId',[]))!==8453n)throw Error('chain');const receipt=await rpc('eth_getTransactionReceipt',[tx]);if(!receipt||receipt.transactionHash.toLowerCase()!==tx||BigInt(receipt.blockNumber)!==height||BigInt(receipt.status)!==1n)throw Error('receipt');const block=await rpc('eth_getBlockByNumber',['0x'+height.toString(16),false]);if(!block||block.hash!==receipt.blockHash||block.transactions[Number(BigInt(receipt.transactionIndex))]!==tx)throw Error('membership');const finalized=await rpc('eth_getBlockByNumber',['finalized',false]);const anchor=await rpc('eth_getBlockByNumber',['0x'+height.toString(16),false]);if(anchor.hash!==block.hash)throw Error('reorg');row.receiptBlock=String(height);row.receiptBlockHash=block.hash;row.finalizedBlock=String(BigInt(finalized.number));row.finalizedHash=finalized.hash;row.coveredByFinalized=BigInt(finalized.number)>=height;row.ok=true;}catch(e){row.error=String(e.message).slice(0,300);process.exitCode=1;}
}
const quorum=results.length===2&&results.every(r=>r.ok&&r.coveredByFinalized)&&results[0].receiptBlockHash===results[1].receiptBlockHash;
const out={at:new Date().toISOString(),readOnly:true,tx,quorumFinalized:quorum,results};fs.writeFileSync(new URL('./result.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
