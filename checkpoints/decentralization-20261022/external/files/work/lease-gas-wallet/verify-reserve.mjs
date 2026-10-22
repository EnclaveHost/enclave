// Read-only post-signature verification. Never deploys, funds, binds, signs or broadcasts.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http, parseAbi, keccak256 } from '../enclave/node_modules/viem/_esm/index.js';
import { checkCreationLanding } from './request.mjs';
const ABI=parseAbi([
 'function owner() view returns(address)','function ledger() view returns(address)',
 'function registry() view returns(address)','function l1Oracle() view returns(address)',
 'function executor() view returns(address)','function paused() view returns(bool)',
 'function limits() view returns(uint64,uint32,uint32,uint32,uint32,uint16)',
]);
const FIELDS=['maxGasPriceCeiling','overheadClaimGas','overheadRenewGas','overheadReleaseGas','minClaimInterval','l1Bps'];
export async function verifyReserve({request,hash,clients}) {
 assert.match(hash,/^0x[0-9a-fA-F]{64}$/,'invalid transaction hash');
 assert.equal(clients.length,2,'requires two independently operated providers');
 assert.notEqual(clients[0],clients[1],'duplicate client');
 assert.equal(new Set(clients.map(c=>new URL(c.transport.url).hostname)).size,2,'duplicate RPC host');
 const heads=await Promise.all(clients.map(c=>c.getBlockNumber({cacheTime:0})));
 const blockNumber=heads.reduce((a,b)=>a<b?a:b)-2n;
 const results=await Promise.all(clients.map(async c=>{
  assert.equal(await c.getChainId(),8453,'wrong chain');
  const [anchor,tx,receipt]=await Promise.all([c.getBlock({blockNumber}),c.getTransaction({hash}),c.getTransactionReceipt({hash})]);
  assert.equal(tx.hash.toLowerCase(),hash.toLowerCase(),'provider returned another transaction');
  assert.ok(receipt.blockNumber<=blockNumber,'creation lacks two later blocks');
  const mined=await c.getBlock({blockNumber:receipt.blockNumber});
  assert.equal(mined.hash,receipt.blockHash,'creation receipt is not canonical');
  const code=await c.getCode({address:receipt.contractAddress,blockNumber});
  const address=checkCreationLanding(request,{transaction:tx,receipt,code});
  const read=functionName=>c.readContract({address,abi:ABI,functionName,blockNumber});
  const [owner,ledger,registry,l1Oracle,executor,paused,limits]=await Promise.all(['owner','ledger','registry','l1Oracle','executor','paused','limits'].map(read));
  for(const [name,got] of Object.entries({owner,ledger,registry,oracle:l1Oracle}))
   assert.equal(got.toLowerCase(),request.binding[name].toLowerCase(),`unexpected ${name}`);
  assert.equal(executor,'0x0000000000000000000000000000000000000000','reserve already bound; inspect before next step');
  assert.equal(paused,false,'reserve unexpectedly paused');
  FIELDS.forEach((name,i)=>assert.equal(String(limits[i]),String(request.binding.limits[name]),`unexpected limit ${name}`));
  assert.equal((await c.getBlock({blockNumber})).hash,anchor.hash,'verification block changed');
  return {address,blockNumber:String(blockNumber),blockHash:anchor.hash,creationBlock:String(receipt.blockNumber),creationBlockHash:receipt.blockHash,
    transactionHash:hash.toLowerCase(),runtimeHash:keccak256(code),owner,ledger,registry,oracle:l1Oracle,executor,paused,limits:limits.map(String)};
 }));
 assert.deepEqual(results[0],results[1],'providers disagree on confirmed reserve');
 return {status:'reserve creation verified; executor not yet deployed or bound',verifiedAt:new Date().toISOString(),providers:2,...results[0],fundingReady:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [requestFile,hash,out]=process.argv.slice(2);
 if(!requestFile||!hash||!out)throw Error('usage: node verify-reserve.mjs REQUEST_JSON TX_HASH OUTPUT_JSON');
 const request=JSON.parse(fs.readFileSync(requestFile));
 const urls=['https://base-rpc.publicnode.com','https://mainnet.base.org'];
 const clients=urls.map(url=>createPublicClient({transport:http(url,{timeout:15000,retryCount:0})}));
 const result=await verifyReserve({request,hash,clients});
 fs.writeFileSync(out,JSON.stringify({...result,rpcProviders:urls},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:result.status,address:result.address,transactionHash:result.transactionHash,fundingReady:false}));
}
