import fs from 'node:fs';import assert from 'node:assert/strict';import{createPublicClient,http,decodeFunctionData,encodeFunctionData}from'./enclave/node_modules/viem/_esm/index.js';
const p=JSON.parse(fs.readFileSync('outputs/adapter-release/transactions.json')),art=JSON.parse(fs.readFileSync('outputs/adapter-correction/upload.json'));assert.equal(art.verifiedReadback,true,'artifact readback required');
const ca=JSON.parse(fs.readFileSync('work/enclave/contracts/EnclaveAppCatalog.abi.json')),la=JSON.parse(fs.readFileSync('work/enclave/contracts/EnclaveDeployments.abi.json'));const c=createPublicClient({transport:http('https://base.drpc.org')});assert.equal(await c.getChainId(),8453);
const appId=p.newAppRef.split('/')[2],old=p.transactions[0],owner=old.from;const args=decodeFunctionData({abi:ca,data:old.data}).args;args[3]='1.0.17';args[4]=art.cid;
const current=await c.readContract({address:p.transactions[1].to,abi:la,functionName:'get',args:[p.deployment]});assert.equal(current.owner.toLowerCase(),owner.toLowerCase());assert.equal(current.appRef,p.newAppRef);assert.deepEqual(JSON.parse(current.configCid),p.deploymentConfig);
const mode=process.argv[2]||'publish';let tx;
if(mode==='publish'){
 const sim=await c.simulateContract({account:owner,address:old.to,abi:ca,functionName:'publishVersion',args});assert.equal(Number(sim.result[1]),17);tx={chainId:8453,from:owner,to:old.to,value:'0x0',data:encodeFunctionData({abi:ca,functionName:'publishVersion',args})};
}else if(mode==='upgrade'){
 const v=await c.readContract({address:old.to,abi:ca,functionName:'getVersion',args:[appId,17n]});assert.equal(v.cid,art.cid);assert.equal(v.approval,1);assert.equal(v.yanked,false);assert.deepEqual(JSON.parse(v.config),p.catalogConfig);
 tx={chainId:8453,from:owner,to:p.transactions[1].to,value:'0x0',data:encodeFunctionData({abi:la,functionName:'setAppRef',args:[p.deployment,`catalog://${appId}/17`]})};
}else throw Error('invalid mode');
await c.call({account:owner,to:tx.to,data:tx.data,value:0n});const gas=await c.estimateGas({account:owner,to:tx.to,data:tx.data,value:0n});
const result={status:'ready-for-owner-signature',checkedAt:new Date().toISOString(),purpose:mode==='publish'?'Publish corrected adapter 1.0.17, retaining production fixes and wallet uploads':'Upgrade adapter to corrected 1.0.17; existing wallet-audience configuration is retained',transaction:tx,estimatedGas:gas.toString(),artifact:art};fs.writeFileSync(`outputs/adapter-correction/${mode}-request.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({mode,gas:gas.toString(),cid:art.cid}));
