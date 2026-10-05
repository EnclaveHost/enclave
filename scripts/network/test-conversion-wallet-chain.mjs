#!/usr/bin/env node
// Real local EVM transfers/signatures. Mock token and rollup gas oracle only;
// native-chain RPC is simulated. This does not create a conversion order.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http} from 'viem';import {base} from 'viem/chains';import {privateKeyToAccount} from 'viem/accounts';
import {ProviderConversionWallet} from '../../network/conversion/provider-wallet.mjs';import {DurableState} from '../../network/durable-state.mjs';import {ASSETS} from '../../network/conversion/policy.mjs';
// Public Anvil development key, unrelated to any provider or production wallet.
const provider=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const deposit=privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const token='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',gasOracle='0x420000000000000000000000000000000000000F';
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const proc=spawn(process.env.ANVIL||'anvil',['--port',String(port),'--chain-id','8453','--block-time','1','--silent'],{stdio:'ignore'});
const transport=http(`http://127.0.0.1:${port}`),client=createPublicClient({chain:base,transport,pollingInterval:100}),wallet=createWalletClient({chain:base,account:provider,transport}),depositWallet=createWalletClient({chain:base,account:deposit,transport});
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'currency-chain-'));
try{
 for(let i=0;i<100;i++){try{await client.getChainId();break;}catch{await new Promise(r=>setTimeout(r,50));}}
 const artifact=JSON.parse(await fs.readFile(new URL('../../contracts/foundry/out/MockUSDC.sol/MockUSDC.json',import.meta.url)));
 await client.request({method:'anvil_setCode',params:[token,artifact.deployedBytecode.object]});
 await client.request({method:'anvil_setCode',params:[gasOracle,'0x600060005260206000f3']});
 // Anvil's finalized tag trails 64 blocks. Mine locally without advancing
 // wall-clock timestamps; production still requires the finalized RPC tag.
 const finalize=()=>client.request({method:'anvil_mine',params:['0x41','0x0']});
 const send=async(w,fn,args)=>{const r=await client.waitForTransactionReceipt({hash:await w.writeContract({address:token,abi:artifact.abi,functionName:fn,args}),confirmations:2});assert.equal(r.status,'success');await finalize();return r;};
 const balance=a=>client.readContract({address:token,abi:artifact.abi,functionName:'balanceOf',args:[a]});
 await send(wallet,'mint',[provider.address,10000000n]);
 const adapter=await new ProviderConversionWallet({account:provider,wallet,clients:[client,client],native:{anchor:async()=>({height:1,hash:'01'.repeat(32),timestamp:Date.now()}),balance:async()=> '100000000'},signNative:async r=>({address:r.address||'NKN-simulated-address'}),store:new DurableState(directory),limits:{nknFee8:'0',maxGasWei:'1000000000000000',maxEthPriceUsdc6:'5000000000'}}).init();
 await adapter.balances();const before=await balance(provider.address);
 const request={key:'local-test-order',transfer:{asset:ASSETS.USDC.id,from:provider.address,to:deposit.address,amount:'1000000'},allInUsdc6:'2000000'};
 const signed=await adapter.prepareTransfer(request);assert.equal(await balance(provider.address),before);
 assert.deepEqual(await adapter.prepareTransfer(request),signed);
 await adapter.broadcast(signed);await client.waitForTransactionReceipt({hash:signed.hash,confirmations:2});
 await finalize();
 assert.equal(await adapter.fundingStatus(signed),'confirmed');assert.equal(await balance(provider.address),before-1000000n);assert.equal(await balance(deposit.address),1000000n);
 const notBefore=Number((await client.getBlock()).timestamp)*1000;
 const returned=await send(depositWallet,'transfer',[provider.address,900000n]);
 const proof=await adapter.verifyTransfer({asset:ASSETS.USDC.id,recipient:provider.address,hash:returned.transactionHash,notBefore});
 assert.equal(proof.amount,'900000');assert.equal(proof.finalized,true);assert.equal(await balance(deposit.address),100000n);
 console.log(JSON.stringify({passed:true,chainId:8453,fundingUSDC6:'1000000',receivedUSDC6:proof.amount,prepareDoesNotBroadcast:true,idempotentSignedFunding:true,canonicalTransferVerified:true,liveConversion:false,nativeChain:'simulated'}));
}finally{await fs.rm(directory,{recursive:true,force:true});if(proc.exitCode===null){proc.kill('SIGTERM');await new Promise(r=>proc.once('exit',r));}}
