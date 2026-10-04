#!/usr/bin/env node
// Real local contracts and signatures; mock USDC/host registration only.
// No production keys, broadcasts or hardware-attestation claims.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import net from 'node:net';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,decodeEventLog,keccak256,toHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';import {foundry} from 'viem/chains';
import {linkBytecode} from '../../site/js/lib/contract-linker.js';
import {TunaUSDCSettlement,TunaReceiptSigner} from '../../network/tuna-usdc-settlement.mjs';
import {TunaTransportController} from '../../network/tuna-transport-control.mjs';
import {startTunaControlServer} from '../../network/tuna-control-server.mjs';
import {readConnectivity} from '../../network/connectivity-chain.mjs';
import {USDCBandwidthSettlement} from '../../network/usdc-bandwidth.mjs';
const owner=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const host=privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const zero='0x'+'00'.repeat(20),payout='0x'+'de'.repeat(20),hostId=keccak256(toHex('host'));
const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const proc=spawn(process.env.ANVIL||'anvil',['--port',String(port),'--block-time','1','--silent'],{stdio:'ignore'});
const transport=http(`http://127.0.0.1:${port}`),client=createPublicClient({chain:foundry,transport,pollingInterval:100});
const wallet=createWalletClient({chain:foundry,account:owner,transport}),hostWallet=createWalletClient({chain:foundry,account:host,transport});
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bandwidth-chain-'));const libraries={};
const artifact=async(file,name)=>JSON.parse(await fs.readFile(new URL(`../../contracts/foundry/out/${file}.sol/${name}.json`,import.meta.url),'utf8'));
const deploy=async(a,args=[])=>{for(const [f,names] of Object.entries(a.bytecode.linkReferences||{}))for(const n of Object.keys(names)){const key=f+':'+n;if(!libraries[key])libraries[key]=await deploy(await artifact(f.split('/').pop().replace(/\.sol$/,''),n));}const hash=await wallet.deployContract({abi:a.abi,bytecode:linkBytecode(a.bytecode.object,a.bytecode.linkReferences,libraries),args});const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r.contractAddress;};
const send=async(w,address,a,functionName,args=[])=>{const r=await client.waitForTransactionReceipt({hash:await w.writeContract({address,abi:a.abi,functionName,args}),confirmations:2});assert.equal(r.status,'success',functionName);return r;};
const read=(address,a,functionName,args=[],blockNumber)=>client.readContract({address,abi:a.abi,functionName,args,...(blockNumber?{blockNumber}:{})});
try{
 for(let n=0;n<100;n++){try{await client.getChainId();break;}catch{await new Promise(r=>setTimeout(r,50));}}
 const t=await artifact('MockUSDC','MockUSDC'),r=await artifact('EnclaveConnectivity.t','ConnectivityRegistry'),d=await artifact('EnclaveDeployments','EnclaveDeployments'),c=await artifact('EnclaveConnectivity','EnclaveConnectivity');
 const token=await deploy(t),registry=await deploy(r);await send(wallet,registry,r,'configure',[host.address,host.address,host.address]);
 const ledger=await deploy(d,[token,payout,registry,zero]),connectivity=await deploy(c,[ledger,[owner.address]]);
 await send(wallet,ledger,d,'setProofRequiredFrom',[0n]);await send(wallet,ledger,d,'setBandwidthRouter',[connectivity]);
 await send(wallet,token,t,'mint',[owner.address,1000_000_000n]);await send(wallet,token,t,'approve',[ledger,1000_000_000n]);
 const created=await send(wallet,ledger,d,'create',['catalog://app/0',0,1000,8080,'',true,'',zero,0n,834n]);
 const id=created.logs.map(l=>{try{return decodeEventLog({abi:d.abi,...l})}catch{return null}}).find(l=>l?.eventName==='Created').args.id;
 await send(wallet,ledger,d,'fund',[id,100_000_000n]);await send(hostWallet,ledger,d,'claim',[id,hostId]);
 const block=await client.getBlock(),issued=block.timestamp,expires=issued+300n,addressHash=keccak256(toHex('8.8.8.8'));
 const q=await read(connectivity,c,'qualificationDigest',[hostId,addressHash,issued,expires,511]);
 await send(wallet,connectivity,c,'qualify',[hostId,addressHash,issued,expires,511,await owner.signMessage({message:{raw:q}})]);
 await send(hostWallet,connectivity,c,'setHost',[hostId,true,true,1000000n]);
 const expiry=issued+3600n,policy=await read(connectivity,c,'policyDigest',[id,expiry,1000000n,10000000n]);
 await send(wallet,connectivity,c,'authorizeDirect',[id,expiry,1000000n,10000000n,await owner.signMessage({message:{raw:policy}})]);
 const backing=await read(ledger,d,'bandwidthBackingRequired6',[id]);await send(wallet,ledger,d,'fundEscrow',[id,backing]);
 let lease;
 const reader={clients:[client,client],get:()=>lease,refresh:async()=>{
  const number=(await client.getBlockNumber({cacheTime:0}))-1n,b=await client.getBlock({blockNumber:number});
  const row=await read(ledger,d,'get',[id],number);
  const [bound]=await readConnectivity(client,{address:connectivity,deployments:ledger,rows:[row],blockNumber:number});
  lease={...row,leaseUntil:Number(row.leaseUntil)*1000,validUntil:Date.now()+90000,chainId:31337,deployments:ledger,blockNumber:String(number),blockHash:b.hash,runnerProofKey:host.address,
   bandwidthBackingRequired6:String(await read(ledger,d,'bandwidthBackingRequired6',[id],number)),
   connectivity:bound.connectivity};return [lease];}};
 await reader.refresh();const before=lease.balance6,platform=await read(token,t,'balanceOf',[payout]);
 const log=[];const adapter=new USDCBandwidthSettlement({directory,leaseReader:reader,proofAccount:host,wallet,client,maxPending6:'1000000',log:s=>log.push(s)});
 const request={deploymentId:id,policyHash:'11'.repeat(32),nonce:'1',pricePerGiB6:'1000000',cumulativeBytes:'1073741824',cumulativeCost6:'1000000'};
 await adapter.authorizeDebit(request);assert.equal(await read(ledger,d,'earned6',[host.address]),0n);
 await adapter.flush();assert.equal(await read(ledger,d,'earned6',[host.address]),800000n,log.join('\n'));
 assert.equal((await read(ledger,d,'get',[id])).balance6,before-1000000n);assert.equal((await read(token,t,'balanceOf',[payout]))-platform,200000n);
 await adapter.flush();assert.equal(await read(ledger,d,'earned6',[host.address]),800000n);
 await reader.refresh();await adapter.authorizeDebit({...request,cumulativeBytes:'2147483648',cumulativeCost6:'2000000'});
 const sendRaw=client.sendRawTransaction;client.sendRawTransaction=async args=>{await sendRaw(args);throw Error('simulated lost broadcast response');};
 await adapter.flush();const journal=await adapter.transactions.get('wallet-current');assert.equal(journal.state,'prepared');
 client.sendRawTransaction=sendRaw;await client.waitForTransactionReceipt({hash:journal.hash,confirmations:2});await adapter.flush();
 assert.equal(await read(ledger,d,'earned6',[host.address]),1600000n,'uncertain broadcast must not duplicate provider earnings');
 await send(wallet,connectivity,c,'revokeDirect',[id]);await reader.refresh();await assert.rejects(adapter.authorizeDebit({...request,cumulativeBytes:'3221225472',cumulativeCost6:'3000000'}),/authorization/);
 const provider=privateKeyToAccount('0x'+'05'.repeat(32)),providerId=keccak256(toHex('separate TUNA provider'));
 const providerWallet=createWalletClient({chain:foundry,account:provider,transport});
 await client.waitForTransactionReceipt({hash:await wallet.sendTransaction({to:provider.address,value:10n**18n})});
 await send(wallet,registry,r,'configureProvider',[providerId,provider.address,provider.address]);
 const qb=await client.getBlock(),qh=keccak256(toHex('9.9.9.9'));
 const qd=await read(connectivity,c,'qualificationDigest',[providerId,qh,qb.timestamp,qb.timestamp+300n,511]);
 await send(wallet,connectivity,c,'qualify',[providerId,qh,qb.timestamp,qb.timestamp+300n,511,await owner.signMessage({message:{raw:qd}})]);
 await send(providerWallet,connectivity,c,'setHost',[providerId,false,true,1000000n]);
 const tunaArgs=[id,[providerId],qb.timestamp+3600n,1000000n,5000000n];
 const tunaPolicy=await read(connectivity,c,'tunaPolicyDigest',tunaArgs);
 await send(wallet,connectivity,c,'authorizeTuna',[...tunaArgs,await owner.signMessage({message:{raw:tunaPolicy}})]);
 await reader.refresh();const tunaBefore=lease.balance6,tunaPlatform=await read(token,t,'balanceOf',[payout]);
 let observed=1073741824n;
 const signer=new TunaReceiptSigner({providerId,proofAccount:provider,leaseReader:reader,observedBytes:async()=>observed});
 const tuna=new TunaUSDCSettlement({providerId,cosign:v=>signer.sign(v),directory:path.join(directory,'tuna'),transactionDirectory:adapter.transactions.directory,leaseReader:reader,proofAccount:host,wallet,client,maxPending6:'0'});
 const tunaRequest={...request,nonce:String(lease.connectivity.nonce)};
 await tuna.authorizeDebit(tunaRequest);
 assert.equal(await read(ledger,d,'earned6',[provider.address]),800000n);
 assert.equal(await read(ledger,d,'earned6',[host.address]),1600000n,'TUNA must not pay the compute host');
 assert.equal((await read(ledger,d,'get',[id])).balance6,tunaBefore-1000000n);
 assert.equal((await read(token,t,'balanceOf',[payout]))-tunaPlatform,200000n);
 await assert.rejects(tuna.authorizeDebit({...tunaRequest,cumulativeBytes:'2147483648',cumulativeCost6:'2000000'}),/observed traffic/);
 assert.equal(await read(ledger,d,'earned6',[provider.address]),800000n,'unobserved bytes must not be charged');

 let transportProof=null;
 if(process.argv.includes('--transport')){
  const controllerRoot=path.join(directory,'transport'),tokenFile=path.join(directory,'control-token');await fs.writeFile(tokenFile,'ab'.repeat(32),{mode:0o600});
  const rc=new TunaTransportController({role:'runner',hostId,proofAccount:host,leaseReader:reader,directory:path.join(controllerRoot,'runner'),maxPending6:'100000',settlementFactory:async(providerId,cosign)=>new TunaUSDCSettlement({providerId,cosign,directory:path.join(controllerRoot,'billing'),transactionDirectory:adapter.transactions.directory,leaseReader:reader,proofAccount:host,wallet,client,maxPending6:'100000',log:s=>log.push(s)}).start()});
  const pc=new TunaTransportController({role:'provider',hostId:providerId,proofAccount:provider,leaseReader:reader,directory:path.join(controllerRoot,'provider'),maxPending6:'100000'});
  const rs=await startTunaControlServer({controller:rc,token:'ab'.repeat(32),intervalMs:1000,log:s=>log.push(s)}),ps=await startTunaControlServer({controller:pc,token:'ab'.repeat(32),intervalMs:1000,log:s=>log.push(s)});
  const previousProvider=await read(ledger,d,'earned6',[provider.address]),previousBalance=(await read(ledger,d,'get',[id])).balance6,previousPlatform=await read(token,t,'balanceOf',[payout]);
  try{
   const config={Runner:{endpoint:'http://127.0.0.1:'+rs.port+'/',tokenFile,deploymentId:id,providerId},Provider:{endpoint:'http://127.0.0.1:'+ps.port+'/',tokenFile}};
   const result=await new Promise((resolve,reject)=>{const p=spawn('go',['test','github.com/nknorg/tuna','-run','^TestUSDCLocalControllerIntegration$','-count=1','-timeout=45s'],{cwd:new URL('../../network/tuna/',import.meta.url),env:{...process.env,ENCLAVE_USDC_TEST_CONTROLLERS:JSON.stringify(config),ENCLAVE_USDC_TEST_WAIT_MS:'5000'}});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('error',reject);p.on('exit',code=>resolve({code,output}));});
   assert.equal(result.code,0,result.output+'\n'+log.join('\n'));
  }finally{await rs.close();await ps.close();}
  const charge=previousBalance-(await read(ledger,d,'get',[id])).balance6,earned=(await read(ledger,d,'earned6',[provider.address]))-previousProvider,fee=(await read(token,t,'balanceOf',[payout]))-previousPlatform;
  const payloadBytes=BigInt(Buffer.byteLength('tls-passthrough\0')*128*1024),expected=(payloadBytes*1000000n+(1n<<30n)-1n)/(1n<<30n);
  assert.equal(charge,expected,log.join('\n'));assert.equal(earned+fee,charge);assert.equal(await read(ledger,d,'earned6',[host.address]),1600000n);
  transportProof={encryptedPayloadBytes:String(payloadBytes),grossUSDC6:String(charge),providerUSDC6:String(earned),platformUSDC6:String(fee),independentMeters:true,realSignatures:true,realLocalChainSettlement:true};
 }
 await send(wallet,connectivity,c,'revokeDirect',[id]);await reader.refresh();
 await assert.rejects(tuna.authorizeDebit({...tunaRequest,cumulativeBytes:'2147483648',cumulativeCost6:'2000000'}),/authorization/);
 console.log(JSON.stringify({passed:true,grossUSDC6:'2000000',providerUSDC6:'1600000',platformUSDC6:'400000',tunaGrossUSDC6:'1000000',tunaProviderUSDC6:'800000',tunaPlatformUSDC6:'200000',dualSignaturesVerified:true,unobservedTrafficRejected:true,existingBalanceDebited:true,uncertainBroadcastRecovered:true,revocationEnforced:true,hardware:'mock registry only',...(transportProof?{transport:transportProof}:{})}));
}finally{await fs.rm(directory,{recursive:true,force:true});if(proc.exitCode===null){proc.kill('SIGTERM');await new Promise(r=>proc.once('exit',r));}}
