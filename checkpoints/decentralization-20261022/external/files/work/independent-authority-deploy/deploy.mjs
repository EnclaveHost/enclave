import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createPublicClient,http,keccak256,parseEther,formatEther} from '../enclave/node_modules/viem/_esm/index.js';
import {privateKeyToAccount} from '../enclave/node_modules/viem/_esm/accounts/index.js';
import {createQuorumReader} from '../enclave/custody/v2/quorum.mjs';
import {authorityReads,verifyIndependentAuthorities} from '../enclave/scripts/independent-authorities.mjs';
const dir='work/independent-authority-deploy',execute=process.argv.includes('--execute');
const artifacts=JSON.parse(fs.readFileSync(dir+'/artifacts.json')),plan=JSON.parse(fs.readFileSync(dir+'/plan.json'));
const rehearsal=JSON.parse(fs.readFileSync(dir+'/rehearsal.json'));
if(!rehearsal.liveRegistryOwnerAcceptance||!rehearsal.foreignOperatorRejected||!rehearsal.bindingsSurviveMutableBookDeletion)throw Error('rehearsal incomplete');
for(const [name,want] of Object.entries(artifacts.sourceSha256)){
 const got=createHash('sha256').update(fs.readFileSync('work/enclave/contracts/'+name)).digest('hex');if(got!==want)throw Error('contract source changed after rehearsal');
}
const urls=['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base.drpc.org','https://base.public.blockpi.network/v1/rpc/public'];
const clients=urls.map(url=>createPublicClient({transport:http(url,{timeout:10000,retryCount:0})})),pc=clients[0];
const agreed=createQuorumReader({clients,minAgree:3,chainId:8453,confirmations:2,timeoutMs:20000});
const preflight=JSON.parse(fs.readFileSync(dir+'/preflight.json'));
await agreed(async(c,b)=>{
 const found={};for(const [name,p] of Object.entries(preflight.dependencies)){
  const code=await authorityReads(c,b.blockHash).code(p.address);if(keccak256(code)!==p.codeHash)throw Error('dependency code changed');found[name]=p.codeHash;
 }return found;
});
const account=privateKeyToAccount(JSON.parse(fs.readFileSync(dir+'/deployer.json')).privateKey);
if(account.address!==plan.deployer)throw Error('deployer mismatch');
const rawKey=JSON.parse(fs.readFileSync('/home/steven/Projects/enclave/metal/config.json')).registryKey;
const funder=privateKeyToAccount(rawKey.startsWith('0x')?rawKey:'0x'+rawKey);
const funding=parseEther('0.00025'),maxFeePerGas=12000000n,maxPriorityFeePerGas=1000000n;
const gasBudgets=Object.fromEntries(rehearsal.transactions.map(tx=>[tx.name,BigInt(tx.gasEstimate)*12n/10n]));
const maximumExecution=Object.values(gasBudgets).reduce((a,b)=>a+b,0n)*maxFeePerGas;
if(maximumExecution>=funding-parseEther('0.000025'))throw Error('execution gas exceeds funded budget');
const gasPrice=await pc.getGasPrice();if(gasPrice>8000000n)throw Error('current fees exceed deployment preflight limit');
console.log(JSON.stringify({execute,funder:funder.address,deployer:account.address,fundingETH:formatEther(funding),maximumExecutionETH:formatEther(maximumExecution),gasPriceWei:String(gasPrice)}));
if(!execute)process.exit(0);
const file=dir+'/journal.json';
let journal=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{chainId:8453,deployer:account.address,funder:funder.address,operations:{}};
if(journal.chainId!==8453||journal.deployer!==account.address||journal.funder!==funder.address)throw Error('journal scope mismatch');
const save=()=>{const temp=file+'.tmp';const fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(journal,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);const d=fs.openSync(dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}};
async function send(label,signer,tx) {
 let op=journal.operations[label];
 if(!op){
  if(await pc.getChainId()!==8453)throw Error('wrong network');
  const serialized=await signer.signTransaction({...tx,chainId:8453,type:'eip1559',maxFeePerGas,maxPriorityFeePerGas});
  op={hash:keccak256(serialized),serialized,nonce:tx.nonce,to:tx.to||null,expectedDataHash:keccak256(tx.data||'0x')};journal.operations[label]=op;save();
 }
 if(op.expectedDataHash!==keccak256(tx.data||'0x')||op.to!==(tx.to||null))throw Error('journal transaction mismatch');
 let receipt=await pc.getTransactionReceipt({hash:op.hash}).catch(()=>null);
 if(!receipt){
  try{await pc.sendRawTransaction({serializedTransaction:op.serialized});}catch(e){
   const known=await pc.getTransaction({hash:op.hash}).catch(()=>null);if(!known)throw Error('broadcast outcome unresolved for '+label+'; inspect saved transaction hash before retrying');
  }
  console.log('Broadcast',label,op.hash);
  receipt=await pc.waitForTransactionReceipt({hash:op.hash,timeout:120000,pollingInterval:1000});
 }
 if(receipt.status!=='success')throw Error('transaction reverted: '+label);
 op.receipt={transactionHash:receipt.transactionHash,blockNumber:String(receipt.blockNumber),contractAddress:receipt.contractAddress,
  gasUsed:String(receipt.gasUsed),effectiveGasPrice:String(receipt.effectiveGasPrice),l1Fee:receipt.l1Fee==null?null:String(receipt.l1Fee)};save();
 console.log('Confirmed',label,op.hash);return receipt;
}
if(!journal.operations.funding){
 const balance=await pc.getBalance({address:account.address});if(balance!==0n||await pc.getTransactionCount({address:account.address})!==0)throw Error('unexpected pre-existing deployer activity');
 if(await pc.getBalance({address:funder.address})<funding+parseEther('0.0005'))throw Error('operator reserve would fall below 0.0005 ETH');
 const latest=await pc.getTransactionCount({address:funder.address,blockTag:'latest'}),pending=await pc.getTransactionCount({address:funder.address,blockTag:'pending'});
 if(latest!==pending)throw Error('operator already has pending transactions; retry after confirmation');
 await send('funding',funder,{nonce:pending,to:account.address,value:funding,gas:21000n});
}else await send('funding',funder,{nonce:journal.operations.funding.nonce,to:account.address,value:funding,gas:21000n});
for(const tx of plan.transactions){
 const receipt=await send(tx.name,account,{nonce:tx.nonce,data:tx.data,value:0n,gas:gasBudgets[tx.name]});
 if(receipt.contractAddress?.toLowerCase()!==tx.address.toLowerCase())throw Error('created contract address mismatch');
}
// Wait for two further Base blocks before cross-provider verification. This is
// a bounded confirmation wait for already saved transaction hashes, not a resend.
const target=BigInt(journal.operations.EnclaveSecretVaultV2.receipt.blockNumber)+2n;
for(let i=0;i<40&&await pc.getBlockNumber({cacheTime:0})<target;i++)await new Promise(r=>setTimeout(r,1000));
const verified=await agreed(async(c,b)=>({contracts:await verifyIndependentAuthorities({artifacts,plan,...authorityReads(c,b.blockHash)})}));
journal.verified={...verified,blockNumber:String(verified.blockNumber),checkedAt:new Date().toISOString()};save();
fs.writeFileSync(dir+'/deployment.json',JSON.stringify({chainId:8453,deployer:account.address,inputs:plan.inputs,addresses:plan.addresses,
 transactions:Object.fromEntries(Object.entries(journal.operations).map(([name,op])=>[name,op.receipt])),verified:journal.verified,
 activation:{bookChanged:false,hostOwnersAssigned:false,sessionGrantsMoved:false,secretBundlesMoved:false,productionRuntimeChanged:false}},null,2)+'\n');
console.log('All six deployed runtimes and immutable bindings verified by RPC majority at block',String(verified.blockNumber));
