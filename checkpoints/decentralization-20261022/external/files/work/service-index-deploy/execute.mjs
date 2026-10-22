import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createPublicClient,http,keccak256,parseEther,formatEther,getContractAddress} from '../enclave/node_modules/viem/_esm/index.js';
import {privateKeyToAccount} from '../enclave/node_modules/viem/_esm/accounts/index.js';
import {createQuorumReader} from '../enclave/custody/v2/quorum.mjs';
const dir='work/service-index-deploy',a=JSON.parse(fs.readFileSync(dir+'/artifact.json')),p=JSON.parse(fs.readFileSync(dir+'/preflight.json'));
if(createHash('sha256').update(fs.readFileSync('work/enclave/contracts/EnclaveServiceIndex.sol')).digest('hex')!==a.sourceSha256)throw Error('source changed after review');
if(keccak256(a.runtime)!==p.codeHash||a.codeHash!==p.codeHash)throw Error('artifact changed');
const account=privateKeyToAccount(JSON.parse(fs.readFileSync('work/independent-authority-deploy/deployer.json')).privateKey);
let key=JSON.parse(fs.readFileSync('/home/steven/Projects/enclave/metal/config.json')).registryKey;const funder=privateKeyToAccount(key.startsWith('0x')?key:'0x'+key);key=null;
if(account.address!==p.deployer||funder.address!==p.funder||getContractAddress({from:account.address,nonce:BigInt(p.nonce)})!==p.target)throw Error('account/target mismatch');
const clients=['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base.drpc.org','https://base.public.blockpi.network/v1/rpc/public'].map(url=>createPublicClient({transport:http(url,{timeout:10000,retryCount:0})}));const pc=clients[0];const q=createQuorumReader({clients,minAgree:3,chainId:8453,confirmations:2,timeoutMs:20000});
const funding=parseEther('0.00005'),maxFeePerGas=12000000n,maxPriorityFeePerGas=1000000n,gas=BigInt(p.gasEstimate)*125n/100n;
if(gas*maxFeePerGas>parseEther('0.00003'))throw Error('gas budget exceeded');
if(await pc.getGasPrice()>8000000n)throw Error('gas price above preflight cap');
const file=dir+'/journal.json',j=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{chainId:8453,deployer:p.deployer,funder:p.funder,target:p.target,codeHash:p.codeHash,operations:{}};
if(j.chainId!==8453||j.deployer!==p.deployer||j.target!==p.target||j.codeHash!==p.codeHash)throw Error('journal mismatch');
const save=()=>{const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(j,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);};
async function send(label,signer,tx){
 let op=j.operations[label];
 if(!op){
  if(await pc.getChainId()!==8453)throw Error('wrong chain');
  const serialized=await signer.signTransaction({...tx,chainId:8453,type:'eip1559',maxFeePerGas,maxPriorityFeePerGas});
  op={hash:keccak256(serialized),serialized,nonce:tx.nonce,to:tx.to||null,dataHash:keccak256(tx.data||'0x'),value:String(tx.value||0n)};j.operations[label]=op;save();
 }
 if(op.to!==(tx.to||null)||op.dataHash!==keccak256(tx.data||'0x')||op.value!==String(tx.value||0n))throw Error('journal transaction scope mismatch');
 let receipt=await pc.getTransactionReceipt({hash:op.hash}).catch(()=>null);
 if(!receipt){
  try{await pc.sendRawTransaction({serializedTransaction:op.serialized});}catch{if(!await pc.getTransaction({hash:op.hash}).catch(()=>null))throw Error('broadcast unresolved; inspect saved hash before retry');}
  console.log(JSON.stringify({broadcast:label,hash:op.hash}));
  receipt=await pc.waitForTransactionReceipt({hash:op.hash,timeout:90000,pollingInterval:1000});
 }
 if(receipt.status!=='success')throw Error(label+' reverted');
 op.receipt={hash:receipt.transactionHash,blockNumber:String(receipt.blockNumber),status:receipt.status,contractAddress:receipt.contractAddress,gasUsed:String(receipt.gasUsed),effectiveGasPrice:String(receipt.effectiveGasPrice)};save();return receipt;
}
if(!j.operations.deploy){
 const initial=await q(async(c,b)=>({nonce:await c.getTransactionCount({address:account.address,blockNumber:b.blockNumber}),code:await c.getCode({address:p.target,blockNumber:b.blockNumber})||'0x',funderBalance:await c.getBalance({address:funder.address,blockNumber:b.blockNumber})}));
 if(initial.nonce!==p.nonce||initial.code!=='0x')throw Error('deployment nonce/target changed');
 if(initial.funderBalance<funding+parseEther('0.000002'))throw Error('funding account balance insufficient');
}
if(!j.operations.fund?.receipt){const nonce=j.operations.fund?.nonce??await pc.getTransactionCount({address:funder.address,blockTag:'pending'});await send('fund',funder,{to:account.address,value:funding,gas:21000n,nonce});}
if(!j.operations.deploy?.receipt){
 if(!j.operations.deploy&&await pc.getTransactionCount({address:account.address,blockTag:'pending'})!==p.nonce)throw Error('pending deployer nonce changed');
 await send('deploy',account,{data:a.bytecode,gas,nonce:p.nonce});
}
const receipt=j.operations.deploy.receipt;if(receipt.contractAddress?.toLowerCase()!==p.target.toLowerCase())throw Error('receipt target mismatch');
let verified;
for(let i=0;i<8;i++){
 try{verified=await q(async(c,b)=>{if(b.blockNumber<BigInt(receipt.blockNumber))throw Error('confirmation not reached');const code=await c.getCode({address:p.target,blockNumber:b.blockNumber});if(code!==a.runtime)throw Error('deployed runtime differs');return{codeHash:keccak256(code)};});break;}catch(e){if(i===7)throw e;await new Promise(r=>setTimeout(r,2000));}
}
j.verified=JSON.parse(JSON.stringify(verified,(_,v)=>typeof v==='bigint'?v.toString():v));save();
const out={at:new Date().toISOString(),chainId:8453,address:p.target,sourceCommit:a.sourceCommit,sourceSha256:a.sourceSha256,compiler:a.compiler,compilerSha256:a.compilerSha256,settings:a.settings,codeHash:a.codeHash,deployTransaction:receipt.hash,deployBlock:receipt.blockNumber,verification:j.verified,operatorAuthority:'no owner, admin, pause, upgrade or global deletion',activation:{contractDeployed:true,advertisementsPublished:false,profileUpdated:false,clientRollout:false},fundedETH:formatEther(funding)};
fs.mkdirSync('outputs/service-index',{recursive:true});fs.writeFileSync('outputs/service-index/deployment.json',JSON.stringify(out,null,2)+'\n');fs.writeFileSync(dir+'/deployment.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
