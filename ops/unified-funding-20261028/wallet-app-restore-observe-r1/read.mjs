import fs from 'node:fs';
import { createPublicClient, http, parseAbiItem, parseAbi } from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-kvm-guest/node_modules/viem/_esm/index.js';
import { ABI, PINS, viemReader, readSnapshot } from '../wallet-release-prod-root-repaired-r3/candidate/enclave/site/js/core/wallet-release-chain.js';
const urls=['https://api.enclave.host/rpc/base','https://rpc.baseazul.dev'];
const wallet='0x0b2d009c0c9af05b12100d77f3c815fea822ee61',vault='0xb794c4dd0e1c5e6b72281799f282bfde7654345d';
const ids=['0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c','0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b'];
const releaseTx='0x02fcaf17c60f3890252202d4f66f39712fe453955dd1a992ebefef4e23f8c437';
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
const out={at:new Date().toISOString(),readOnly:true,assurance:'Two providers at one fresh common block; not cryptographic finality. No signer, send, refund or replay.',urls};
try {
 const clients=urls.map(url=>createPublicClient({transport:http(url,{timeout:10000,retryCount:0})}));
 const heads=await Promise.all(clients.map(async c=>{if(await c.getChainId()!==8453)throw Error('wrong chain');return c.getBlockNumber({cacheTime:0});}));
 const at=(heads[0]<heads[1]?heads[0]:heads[1])-2n;
 if(at<53273632n)throw Error('head predates latest release');
 const blocks=await Promise.all(clients.map(c=>c.getBlock({blockNumber:at})));
 if(blocks[0].hash!==blocks[1].hash||Math.abs(Date.now()/1000-Number(blocks[0].timestamp))>120)throw Error('block disagreement/staleness');
 out.block={number:at,hash:blocks[0].hash,timestamp:blocks[0].timestamp};
 out.observations=[];
 for(let i=0;i<clients.length;i++){
  const c=clients[i],r=viemReader(c),b=await r.blockByNumber(at);
  r.latestBlock=async()=>b;
  const apps=[];
  for(const id of ids){
   const snap=await readSnapshot(r,{wallet,vault,id});
   const refundable=await c.readContract({address:PINS.ledger,abi:parseAbi(['function refundableOf(bytes32) view returns(uint256)']),functionName:'refundableOf',args:[id],blockNumber:at});
   const refunds=[];
   apps.push({snapshot:snap,refundable,refunds:refunds.map(l=>({txHash:l.transactionHash,blockNumber:l.blockNumber,blockHash:l.blockHash,logIndex:l.logIndex,args:l.args}))});
  }
  const transferredOwner=(await r.read(PINS.ledger,ABI.ledger,'get',['0xa62e13de22559ee9a6ce1798891ab3506ac8e1b1eca296ff749cfcd7ab4fc640'],at)).owner;
  const rc=await c.getTransactionReceipt({hash:releaseTx});
  const final=await c.getBlock({blockTag:'finalized'});
  const observed={apps,transferredOwner,release:{hash:rc.transactionHash,status:rc.status,block:rc.blockNumber,blockHash:rc.blockHash},finalized:{number:final.number,hash:final.hash}};
  if((await c.getBlock({blockNumber:at})).hash!==b.hash)throw Error('anchor changed');
  out.observations.push(observed);
 }
 if(json(out.observations[0].apps)!==json(out.observations[1].apps)||json(out.observations[0].release)!==json(out.observations[1].release))throw Error('poststate disagreement');
 if(out.observations[0].transferredOwner.toLowerCase()!==wallet || out.observations[1].transferredOwner.toLowerCase()!==wallet)throw Error('a62 owner not wallet');
 out.agreed=true;
 out.releaseBelowBothFinalized=out.observations.every(o=>o.finalized.number>=o.release.block);
}catch(e){out.error=String(e.shortMessage||e.message).slice(0,1500);process.exitCode=1;}
fs.writeFileSync(new URL('./result.json',import.meta.url),json(out)+'\n');
console.log(json({agreed:out.agreed,error:out.error,block:out.block,releaseBelowBothFinalized:out.releaseBelowBothFinalized,apps:out.observations?.[0]?.apps.map(a=>({id:a.snapshot.identity.deployment,row:a.snapshot.pre.row,ownerEscrow:a.snapshot.pre.ownerEscrow6,earn:a.snapshot.pre.earn,refundable:a.refundable,refunds:a.refunds}))}));
