import fs from 'node:fs';
import {createPublicClient,http} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-kvm-guest/node_modules/viem/_esm/index.js';
import {ABI,PINS,viemReader} from '../wallet-release-reader-repair-r4/candidate/enclave/site/js/core/wallet-release-chain.js';
const tx='0x7b71d6205e708bcf07459df18d3291685fc718145aa6164a255d565ef099df3e', id='0x87508b958c4d14381b58fe05a781efbd3f185a36d5239abdf37e8f242f944538',wallet='0x0b2d009c0c9af05b12100d77f3c815fea822ee61';
const urls=['https://api.enclave.host/rpc/base','https://rpc.baseazul.dev'];const out={at:new Date().toISOString(),tx,id,readOnly:true,observations:[]};const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
try{
 const clients=urls.map(url=>createPublicClient({transport:http(url,{timeout:10000,retryCount:0})}));
 const heads=await Promise.all(clients.map(c=>c.getBlockNumber({cacheTime:0})));const at=(heads[0]<heads[1]?heads[0]:heads[1])-2n;if(at<53273632n)throw Error('head before inclusion');
 for(let i=0;i<clients.length;i++){
 const c=clients[i],r=viemReader(c);if(await c.getChainId()!==8453)throw Error('chain');const anchor=await c.getBlock({blockNumber:at});if(Math.abs(Date.now()/1000-Number(anchor.timestamp))>120)throw Error('stale');
 if(await r.codeHash(PINS.ledger,at)!==PINS.ledgerCodeHash)throw Error('ledger code');if(await r.read(PINS.ledger,ABI.ledger,'deploymentsSchema',[],at)!==16n)throw Error('schema');
 const row=await r.read(PINS.ledger,ABI.ledger,'get',[id],at);if(row.owner.toLowerCase()!==wallet)throw Error('owner not expected wallet');
 const rc=await c.getTransactionReceipt({hash:tx});if(rc.status!=='success'||rc.blockNumber!==53273632n)throw Error('receipt');const block=await c.getBlock({blockNumber:rc.blockNumber});if(block.hash!==rc.blockHash||block.transactions[rc.transactionIndex]!==tx)throw Error('receipt membership');
 const final=await c.getBlock({blockTag:'finalized'});if((await c.getBlock({blockNumber:at})).hash!==anchor.hash||(await c.getBlock({blockNumber:rc.blockNumber})).hash!==block.hash)throw Error('anchor changed');
 out.observations.push({url:urls[i],at,anchorHash:anchor.hash,row,receipt:{transactionHash:tx,blockNumber:rc.blockNumber,blockHash:rc.blockHash,status:rc.status},finalized:{number:final.number,hash:final.hash},belowFinalized:final.number>=rc.blockNumber});
 }
 const[a,b]=out.observations;if(a.anchorHash!==b.anchorHash||json(a.row)!==json(b.row)||json(a.receipt)!==json(b.receipt))throw Error('provider disagreement');out.agreed=true;out.belowBothFinalized=out.observations.every(x=>x.belowFinalized);
}catch(e){out.error=String(e.shortMessage||e.message).slice(0,1000);process.exitCode=1;}
fs.writeFileSync(new URL('./result.json',import.meta.url),json(out)+'\n');console.log(json(out));
