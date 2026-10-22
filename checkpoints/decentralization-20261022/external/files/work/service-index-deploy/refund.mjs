import fs from 'node:fs';
import {createPublicClient,http,keccak256,parseEther,formatEther} from '../enclave/node_modules/viem/_esm/index.js';
import {privateKeyToAccount} from '../enclave/node_modules/viem/_esm/accounts/index.js';
import {createQuorumReader} from '../enclave/custody/v2/quorum.mjs';
const dir='work/service-index-deploy',file=dir+'/journal.json',j=JSON.parse(fs.readFileSync(file)),pre=JSON.parse(fs.readFileSync(dir+'/preflight.json'));
if(!j.verified)throw Error('deployment not verified');
const account=privateKeyToAccount(JSON.parse(fs.readFileSync('work/independent-authority-deploy/deployer.json')).privateKey);if(account.address!==j.deployer)throw Error('account mismatch');
const clients=['https://base.public.blockpi.network/v1/rpc/public','https://mainnet.base.org','https://base-rpc.publicnode.com','https://base.drpc.org'].map(url=>createPublicClient({transport:http(url,{timeout:10000,retryCount:0})}));const pc=clients[0];const q=createQuorumReader({clients,minAgree:3,chainId:8453,confirmations:2,timeoutMs:20000});
const save=()=>{const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(j,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);};
if(!j.refund){
 const s=await q(async(c,b)=>({balance:await c.getBalance({address:account.address,blockNumber:b.blockNumber}),nonce:await c.getTransactionCount({address:account.address,blockNumber:b.blockNumber})}));
 if(s.nonce!==pre.nonce+1||await pc.getTransactionCount({address:account.address,blockTag:'pending'})!==s.nonce)throw Error('refund nonce changed');
 const reserve=parseEther('0.000001');if(s.balance<=reserve)throw Error('no refundable excess');
 const value=s.balance-reserve;const serialized=await account.signTransaction({chainId:8453,type:'eip1559',to:j.funder,value,nonce:s.nonce,gas:21000n,maxFeePerGas:12000000n,maxPriorityFeePerGas:1000000n});
 j.refund={hash:keccak256(serialized),serialized,value:String(value),balanceBefore:String(s.balance),nonce:s.nonce,to:j.funder};save();
}
let r=await pc.getTransactionReceipt({hash:j.refund.hash}).catch(()=>null);
if(!r){try{await pc.sendRawTransaction({serializedTransaction:j.refund.serialized});}catch{if(!await pc.getTransaction({hash:j.refund.hash}).catch(()=>null))throw Error('refund broadcast unresolved; inspect saved hash');}console.log(JSON.stringify({refundBroadcast:j.refund.hash}));r=await pc.waitForTransactionReceipt({hash:j.refund.hash,timeout:90000,pollingInterval:1000});}
if(r.status!=='success')throw Error('refund reverted');j.refund.receipt={hash:r.transactionHash,status:r.status,blockNumber:String(r.blockNumber)};save();
let after;
for(let i=0;i<8;i++){try{after=await q(async(c,b)=>{if(b.blockNumber<r.blockNumber)throw Error('await confirmation');return{balance:await c.getBalance({address:account.address,blockNumber:b.blockNumber})};});break;}catch(e){if(i===7)throw e;await new Promise(r=>setTimeout(r,2000));}}
const costs={fundedETH:'0.00005',deployerInitialETH:pre.balanceETH,contractDeploymentFeeETH:formatEther(BigInt(pre.balanceWei)+parseEther('0.00005')-BigInt(j.refund.balanceBefore)),refundETH:formatEther(BigInt(j.refund.value)),refundTransaction:j.refund.hash,remainingReserveETH:formatEther(after.balance),verifiedBlock:String(after.blockNumber),funder:j.funder,deployer:j.deployer};fs.writeFileSync(dir+'/costs.json',JSON.stringify(costs,null,2)+'\n');fs.writeFileSync('outputs/service-index/costs.json',JSON.stringify(costs,null,2)+'\n');console.log(JSON.stringify(costs,null,2));
