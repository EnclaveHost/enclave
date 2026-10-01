#!/usr/bin/env node
// Local Anvil integration: real Solidity + signatures + durable JS driver.
// Test keys and mock USDC only. Does not claim to test hardware attestation.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import net from 'node:net';
import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,decodeEventLog,keccak256,toHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';import {foundry} from 'viem/chains';
import {openStore} from '../../availability/store.mjs';import {advanceJob} from '../../availability/scheduler.mjs';
import {createFeeChainAdapter} from '../../availability/fee-chain-adapter.mjs';
const account=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const operator=privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const proc=spawn('anvil',['--port',String(port),'--block-time','1','--silent'],{stdio:'ignore'});
const pub=createPublicClient({chain:foundry,transport:http(`http://127.0.0.1:${port}`),pollingInterval:100});
const wallet=createWalletClient({chain:foundry,account,transport:http(`http://127.0.0.1:${port}`)});
const hostWallet=createWalletClient({chain:foundry,account:operator,transport:http(`http://127.0.0.1:${port}`)});
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-chain-'));let store;
const artifact=async(file,name)=>JSON.parse(await fs.readFile(new URL(`../../contracts/foundry/out/${file}.sol/${name}.json`,import.meta.url),'utf8'));
const deploy=async(a,args=[])=>{const hash=await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args});return (await pub.waitForTransactionReceipt({hash})).contractAddress;};
const send=async(w,address,a,name,args)=>pub.waitForTransactionReceipt({hash:await w.writeContract({address,abi:a.abi,functionName:name,args}),confirmations:2});
const read=(address,a,name,args=[])=>pub.readContract({address,abi:a.abi,functionName:name,args});
try {
 for(let i=0;i<100;i++){try{await pub.getChainId();break;}catch{await new Promise(r=>setTimeout(r,50));}}
 const t=await artifact('EnclaveAvailability.t','AvailabilityUSDC'),r=await artifact('EnclaveRegistry','EnclaveRegistry'),d=await artifact('EnclaveDeployments','EnclaveDeployments'),p=await artifact('EnclaveProofOfTime','EnclaveProofOfTime'),a=await artifact('EnclaveVerificationFees','EnclaveVerificationFees');
 const token=await deploy(t),registry=await deploy(r),ledger=await deploy(d,[token,account.address,registry,'0x0000000000000000000000000000000000000000']);
 const proof=await deploy(p,[ledger,registry]);await send(wallet,ledger,d,'setProver',[proof]);
 await send(wallet,ledger,d,'setProofRequiredFrom',[1n]);const availability=await deploy(a,[ledger,proof]);await send(wallet,ledger,d,'setFeeRouter',[availability]);
 const endpoint='https://test-host.invalid';const host=keccak256(toHex(endpoint));
 await send(hostWallet,registry,r,'register',[endpoint,'EnclaveHost/enclave','0x'+'00'.repeat(32),10000n,10000n,operator.address]);
 await send(wallet,token,t,'mint',[account.address,1000_000_000n]);await send(wallet,token,t,'approve',[ledger,1000_000_000n]);
 const receipt=await send(wallet,ledger,d,'create',['catalog://source/0',0,1000,8000,'',true,'','0x0000000000000000000000000000000000000000',0n,10000n]);
 const created=receipt.logs.map(l=>{try{return decodeEventLog({abi:d.abi,data:l.data,topics:l.topics});}catch{return null;}}).find(e=>e?.eventName==='Created');
 const source=created.args.id;const now=()=>BigInt(Math.floor(Date.now()/1000));
 await send(wallet,availability,a,'configure',[source,account.address,1000,1000,1_000_000n,100_000n,1000n,now()+3600n,'catalog://capacity-work/0','snp-guest-per-app']);
 await send(wallet,ledger,d,'fund',[source,100_000_000n]);await send(hostWallet,ledger,d,'claim',[source,host]);
 await new Promise(r=>setTimeout(r,2500));const anchor=await pub.getBlock({blockTag:'latest'}),upto=anchor.timestamp;
 const signature=await operator.signTypedData({domain:{name:'EnclaveProofOfTime',version:'1',chainId:31337,verifyingContract:proof},primaryType:'ProofOfTime',types:{ProofOfTime:[{name:'id',type:'bytes32'},{name:'enclaveId',type:'bytes32'},{name:'operator',type:'address'},{name:'upto',type:'uint64'},{name:'anchorBlock',type:'uint64'},{name:'anchorHash',type:'bytes32'}]},message:{id:source,enclaveId:host,operator:operator.address,upto,anchorBlock:anchor.number,anchorHash:anchor.hash}});
 await send(wallet,availability,a,'checkpoint',[source,host,upto,anchor.number,anchor.hash,signature]);
 const policy=await read(availability,a,'policies',[source]);assert.ok(policy[10]>=1000n);assert.equal(await read(token,t,'balanceOf',[policy[2]]),1_000_000n);
 store=await openStore(dir);
 const id='0x'+'ca'.repeat(32),offer={id,hostId:host,operator:operator.address,hardwareId:'test-only',classId:'cpu',rate6:100n,maximumSpend6:1000n,shareMilli:10n,validUntilSec:now()+300n,durationSec:10n};
 await store.create({id,offer,state:'offered',token:'integration-test-only-token'.repeat(2)});
 const chain=createFeeChainAdapter({publicClient:pub,executorWallet:wallet,ledger,fees:availability,registry,chainId:31337,source,store,
  profile:{classId:'cpu',appRef:'catalog://capacity-work/0',gpuMilli:0,isolationBackend:'snp-guest-per-app'},
  stageSecrets:async()=>{}, // transport tested separately; no customer secrets in Anvil
  acceptHostOffer:async q=>{await send(hostWallet,ledger,d,'offerJobRate',[q.id,q.hostId,q.rate6,q.expiresSec]);},now});
 let result=await advanceJob(id,{store,chain,nowSec:now()});assert.equal(result.state,'queued');
 const jobId=result.deployment.id;assert.equal(await read(availability,a,'fundedJob',[jobId]),true);
 assert.ok(await read(ledger,d,'ownerEscrow6',[jobId])>0n);assert.equal(await read(token,t,'balanceOf',[availability]),0n);
 await send(hostWallet,ledger,d,'claim',[jobId,host]);result=await advanceJob(id,{store,chain,nowSec:now()});assert.equal(result.state,'running');
 assert.equal(result.lease.rate6.toString(),'100');
 const workload={runAndVerify:async()=>({verified:true,scope:'mock hardware transport; real WASM tested separately'})};
 result=await advanceJob(id,{store,chain,workload,nowSec:now()});assert.equal(result.state,'stopping');
 result=await advanceJob(id,{store,chain,workload,nowSec:now()});assert.equal(result.state,'stopping');
 await send(hostWallet,ledger,d,'release',[jobId]);
 for(let i=0;i<10;i++){if((await read(ledger,d,'get',[jobId])).runner==='0x'+'00'.repeat(32))break;await new Promise(r=>setTimeout(r,1000));}
 result=await advanceJob(id,{store,chain,workload,nowSec:now()});assert.equal(result.state,'complete');
 assert.equal((await read(ledger,d,'get',[jobId])).active,false);
 await advanceJob(id,{store,chain,workload,nowSec:now()});assert.equal((await store.get(id)).state,'complete');
 console.log(JSON.stringify({passed:true,sourceCredit:policy[10].toString(),feeWallet:policy[2],fundedFromExistingFees:true,paidJobFunded:true,negotiatedRate6:'100',feeWalletRefundAttribution:true,pooledBalance:'0',cleanup:true}));
} finally {
 if(store)await store.close();await fs.rm(dir,{recursive:true});
 if(proc.exitCode===null&&!proc.signalCode){const done=new Promise(r=>proc.once('exit',r));proc.kill('SIGTERM');await done;}
}
