import fs from 'node:fs';
import assert from 'node:assert/strict';
import {LeaseReader} from './enclave/network/lease-reader.mjs';
const p=JSON.parse(fs.readFileSync('outputs/adapter-release/transactions.json'));
const ca=JSON.parse(fs.readFileSync('work/enclave/contracts/EnclaveAppCatalog.abi.json')),la=JSON.parse(fs.readFileSync('work/enclave/contracts/EnclaveDeployments.abi.json'));
const reader=new LeaseReader({rpc:['https://base-rpc.publicnode.com','https://base.drpc.org','https://mainnet.base.org'],addressBook:'0xab214342d5A490150A4A977063A2f88E21F80907'});
const pub=p.transactions[0],appId=p.newAppRef.split('/')[2];
const observation=await reader.agreed(async(c,blockNumber)=>{
const [v,a,d,fee]=await Promise.all([c.readContract({address:pub.to,abi:ca,functionName:'getVersion',args:[appId,16n],blockNumber}),c.readContract({address:pub.to,abi:ca,functionName:'getApp',args:[appId],blockNumber}),c.readContract({address:p.transactions[1].to,abi:la,functionName:'get',args:[p.deployment],blockNumber}),c.readContract({address:pub.to,abi:ca,functionName:'versionFee',args:[appId,16n],blockNumber})]);
assert.equal(v.cid,p.artifact.cid);assert.equal(v.version,p.version);assert.deepEqual(JSON.parse(v.config),p.catalogConfig);assert.equal(a.publisher.toLowerCase(),pub.from.toLowerCase());assert.equal(d.owner.toLowerCase(),pub.from.toLowerCase());assert.equal(v.yanked,false);assert.equal(fee,0n);
return {cid:v.cid,version:v.version,approval:Number(v.approval),yanked:v.yanked,configMatches:true,publisher:a.publisher,deploymentAppRef:d.appRef,publishedAt:new Date(Number(v.createdAt)*1000).toISOString()};
});
const c=reader.clients[0];const logs=await c.getContractEvents({address:pub.to,abi:ca,eventName:'VersionPublished',args:{appId,index:16n},fromBlock:52800909n,toBlock:BigInt(observation.blockNumber)});
if(logs.length!==1)throw Error('Expected exactly one publication');const hash=logs[0].transactionHash;
const receipt=await reader.clients[1].getTransactionReceipt({hash});assert.equal(receipt.status,'success');const tx=await reader.clients[1].getTransaction({hash});assert.equal(tx.from.toLowerCase(),pub.from.toLowerCase());assert.equal(tx.input,pub.data);assert.equal(tx.value,0n);
const out={checkedAt:new Date().toISOString(),status:'published-verified',transactionHash:hash,receiptStatus:receipt.status,calldataExactMatch:true,observation};
fs.writeFileSync('outputs/adapter-release/publication-receipt.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
