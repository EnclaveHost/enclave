import fs from 'node:fs';
import {createPublicClient,http,keccak256,encodeFunctionData,parseEther,formatEther} from '../enclave/node_modules/viem/_esm/index.js';
import {privateKeyToAccount} from '../enclave/node_modules/viem/_esm/accounts/index.js';
import {agreedRead,SERVICE_INDEX_ABI,validateAdInput} from '../enclave/network/service-index.mjs';
const dir='work/service-index-advertisements';
const pin=JSON.parse(fs.readFileSync('outputs/service-index/pin.json'));
const operator='0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB';
const urls=['https://base-rpc.publicnode.com','https://base.drpc.org','https://base.public.blockpi.network/v1/rpc/public','https://mainnet.base.org'];
const peers=urls.map(u=>({label:new URL(u).origin,client:createPublicClient({transport:http(u,{timeout:8000,retryCount:0})})}));
const read=async()=>agreedRead({peers,chainId:8453,read:async(c,b,call)=>{
 const code=await call('runtime',()=>c.getCode({address:pin.address,blockNumber:b}));
 if(!code||keccak256(code)!==pin.codeHash)throw Error('service-index runtime differs from reviewed deployment');
 return {sequence:String(await call('sequence',()=>c.readContract({address:pin.address,abi:SERVICE_INDEX_ABI,functionName:'sequenceOf',args:[operator,0],blockNumber:b}))),balance:String(await call('balance',()=>c.getBalance({address:operator,blockNumber:b})))};
}});
const prepareFile=dir+'/directory-prepared.json',journalFile=dir+'/directory-journal.json';
const save=(file,obj)=>{const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(obj,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);};
const json=v=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x));
const mode=process.argv[2]||'prepare';
if(mode==='prepare'){
 if(fs.existsSync(prepareFile))throw Error('existing prepared request must be reviewed, not replaced');
 const snapshot=await read();
 const ad=validateAdInput({slot:0,kind:'directory',ttlSec:30*86400,endpoints:['134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39'].map(ip=>'http://'+ip+':8188')});
 const sequence=BigInt(snapshot.value.sequence)+1n,expiresAt=BigInt(Math.floor(Date.now()/1000)+ad.ttlSec);
 const args=[0,ad.kind,1,sequence,expiresAt,ad.descriptor,ad.endpoints];
 const data=encodeFunctionData({abi:SERVICE_INDEX_ABI,functionName:'publish',args});
 const gas=await peers[0].client.estimateGas({account:operator,to:pin.address,data});
 const gasLimit=gas*130n/100n,maxFee=12000000n;
 if(gasLimit*maxFee>parseEther('0.00001'))throw Error('advertisement gas budget exceeds cap');
 if(BigInt(snapshot.value.balance)<gasLimit*maxFee)throw Error('operator balance insufficient');
 const p={at:new Date().toISOString(),chainId:8453,index:pin.address,codeHash:pin.codeHash,operator,slot:0,kind:'directory',sequence:String(sequence),expiresAt:String(expiresAt),endpoints:ad.endpoints,descriptor:ad.descriptor,data,gasEstimate:String(gas),gasLimit:String(gasLimit),maxFeePerGas:String(maxFee),maxPriorityFeePerGas:'1000000',maxExecutionFeeETH:formatEther(gasLimit*maxFee),verifiedBlock:snapshot.blockNumber,notice:'These are existing Enclave-operated directories, advertised as untrusted candidates. This does not establish independent operators or authorize their contents.'};
 save(prepareFile,p);console.log(JSON.stringify({...p,data:'[encoded publish call]'},null,2));
}else if(mode==='execute'){
 const p=JSON.parse(fs.readFileSync(prepareFile));
 if(p.operator!==operator||p.index!==pin.address||p.codeHash!==pin.codeHash||p.chainId!==8453||p.slot!==0||p.kind!=='directory')throw Error('prepared scope changed');
 const expected=encodeFunctionData({abi:SERVICE_INDEX_ABI,functionName:'publish',args:[0,1,1,BigInt(p.sequence),BigInt(p.expiresAt),p.descriptor,p.endpoints]});
 if(expected!==p.data||BigInt(p.gasLimit)*BigInt(p.maxFeePerGas)>parseEther('0.00001')||BigInt(p.expiresAt)<=BigInt(Math.floor(Date.now()/1000)+3600))throw Error('prepared calldata/budget/expiry invalid');
 let j=fs.existsSync(journalFile)?JSON.parse(fs.readFileSync(journalFile)):null;
 if(!j){
  const s=await read();if(BigInt(s.value.sequence)+1n!==BigInt(p.sequence))throw Error('operator slot changed; do not overwrite');
  const rs=await Promise.allSettled(peers.map(async({client})=>{if(await client.getChainId()!==8453)throw Error('wrong chain');return client.getTransactionCount({address:operator,blockTag:'pending'});}));
  const counts=new Map();for(const r of rs)if(r.status==='fulfilled')counts.set(r.value,(counts.get(r.value)||0)+1);
  const consensus=[...counts].find(([,n])=>n>=3);if(!consensus)throw Error('no three-RPC pending nonce agreement');
  if(await peers[0].client.getGasPrice()>8000000n)throw Error('gas price above reviewed cap');
  let key=JSON.parse(fs.readFileSync('/home/steven/Projects/enclave/metal/config.json')).registryKey;
  const signer=privateKeyToAccount(key.startsWith('0x')?key:'0x'+key);key=null;if(signer.address!==operator)throw Error('operator key mismatch');
  const serialized=await signer.signTransaction({chainId:8453,type:'eip1559',nonce:consensus[0],to:p.index,data:p.data,value:0n,gas:BigInt(p.gasLimit),maxFeePerGas:BigInt(p.maxFeePerGas),maxPriorityFeePerGas:BigInt(p.maxPriorityFeePerGas)});
  j={hash:keccak256(serialized),serialized,nonce:consensus[0],index:p.index,operator,dataHash:keccak256(p.data)};save(journalFile,j);
 }
 if(j.index!==p.index||j.operator!==operator||j.dataHash!==keccak256(p.data))throw Error('journal mismatch');
 let receipt=null;
 for(const {client} of peers){receipt=await client.getTransactionReceipt({hash:j.hash}).catch(()=>null);if(receipt)break;}
 if(!receipt){
  let sent=false;
  for(const {client} of peers){try{const h=await client.sendRawTransaction({serializedTransaction:j.serialized});if(h!==j.hash)throw Error('broadcast hash mismatch');sent=true;break;}catch{}}
  if(!sent)throw Error('broadcast unresolved; inspect journal hash before any new transaction');
  console.log(JSON.stringify({broadcast:j.hash,operator,slot:0}));
  receipt=await peers[0].client.waitForTransactionReceipt({hash:j.hash,timeout:90000,pollingInterval:1000});
 }
 if(receipt.status!=='success')throw Error('advertisement reverted');
 j.receipt=json({hash:receipt.transactionHash,blockNumber:receipt.blockNumber,status:receipt.status,gasUsed:receipt.gasUsed,effectiveGasPrice:receipt.effectiveGasPrice});save(journalFile,j);
 const out={at:new Date().toISOString(),operator,index:p.index,slot:p.slot,kind:p.kind,sequence:p.sequence,expiresAt:p.expiresAt,endpoints:p.endpoints,transaction:j.hash,receipt:j.receipt,executionFeeETH:formatEther(receipt.gasUsed*receipt.effectiveGasPrice),notice:p.notice};
 fs.writeFileSync('outputs/service-index/directory-advertisement.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
}else throw Error('mode must be prepare or execute');
