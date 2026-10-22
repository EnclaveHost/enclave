import fs from 'node:fs';
import {createPublicClient,http,keccak256,parseEther,formatEther} from '../enclave/node_modules/viem/_esm/index.js';
import {privateKeyToAccount} from '../enclave/node_modules/viem/_esm/accounts/index.js';
const dir='work/independent-authority-deploy',file=dir+'/journal.json',j=JSON.parse(fs.readFileSync(file));
if(!j.verified)throw Error('deployments must be verified before cleanup');
const account=privateKeyToAccount(JSON.parse(fs.readFileSync(dir+'/deployer.json')).privateKey);
if(account.address!==j.deployer)throw Error('wrong deployer');
const pc=createPublicClient({transport:http('https://mainnet.base.org',{timeout:10000,retryCount:0})});
if(await pc.getChainId()!==8453)throw Error('wrong chain');
const save=()=>{const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(j,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);};
if(!j.refund){
 const balance=await pc.getBalance({address:account.address}),reserve=parseEther('0.000001');
 if(balance<=reserve)throw Error('no excess funding');
 const nonce=await pc.getTransactionCount({address:account.address,blockTag:'pending'});if(nonce!==4)throw Error('unexpected deployer nonce');
 const value=balance-reserve;
 const serialized=await account.signTransaction({chainId:8453,type:'eip1559',to:j.funder,value,nonce,gas:21000n,maxFeePerGas:12000000n,maxPriorityFeePerGas:1000000n});
 j.refund={hash:keccak256(serialized),serialized,to:j.funder,value:String(value),balanceBefore:String(balance)};save();
}
let r=await pc.getTransactionReceipt({hash:j.refund.hash}).catch(()=>null);
if(!r){await pc.sendRawTransaction({serializedTransaction:j.refund.serialized});console.log('Broadcast refund',j.refund.hash);r=await pc.waitForTransactionReceipt({hash:j.refund.hash,timeout:90000,pollingInterval:1000});}
if(r.status!=='success')throw Error('refund reverted');
j.refund.receipt={hash:r.transactionHash,blockNumber:String(r.blockNumber),status:r.status};save();
const result={fundedETH:'0.00025',deploymentFeesETH:formatEther(parseEther('0.00025')-BigInt(j.refund.balanceBefore)),refundETH:formatEther(BigInt(j.refund.value)),refundTransaction:j.refund.hash,remainingFeeReserveETH:formatEther(await pc.getBalance({address:account.address})),deployer:account.address,funder:j.funder};
fs.writeFileSync(dir+'/costs.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
