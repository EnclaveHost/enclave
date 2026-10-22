import fs from 'node:fs';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createPublicClient,createWalletClient,http,keccak256,toBytes,parseEther} from '../enclave/node_modules/viem/_esm/index.js';
import {privateKeyToAccount} from '../enclave/node_modules/viem/_esm/accounts/index.js';
import {createQuorumReader} from '../enclave/custody/v2/quorum.mjs';
import {REGISTRY_V4_ABI} from '../enclave/custody/v2/chain.mjs';
import {authorityReads,verifyIndependentAuthorities} from '../enclave/scripts/independent-authorities.mjs';
const dir='work/independent-authority-deploy',artifacts=JSON.parse(fs.readFileSync(dir+'/artifacts.json')),plan=JSON.parse(fs.readFileSync(dir+'/plan.json'));
const urls=['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base.drpc.org','https://base.public.blockpi.network/v1/rpc/public'];
const clients=urls.map(url=>createPublicClient({transport:http(url,{timeout:10000,retryCount:0})}));
const read=createQuorumReader({clients,minAgree:3,chainId:8453,confirmations:2});
const preflight=await read(async(c,b)=>{
 const deps={};for(const name of ['usdc','ledger','catalog','registry','router','keyAttestations']){
  const code=await authorityReads(c,b.blockHash).code(plan.inputs[name]);if(!code||code==='0x')throw Error('dependency missing');
  deps[name]={address:plan.inputs[name],codeHash:keccak256(code),bytes:(code.length-2)/2};
 }
 for(const address of Object.values(plan.addresses))if(await authorityReads(c,b.blockHash).code(address)!=='0x')throw Error('planned address occupied');
 return {dependencies:deps};
});
fs.writeFileSync(dir+'/preflight.json',JSON.stringify(preflight,(_,v)=>typeof v==='bigint'?String(v):v,2));
console.log('Verified production dependencies at block',String(preflight.blockNumber));
const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--fork-url',urls[0],'--fork-block-number',String(preflight.blockNumber),'--silent'],{stdio:['ignore','ignore','pipe']});
let error='';child.stderr.on('data',c=>error=(error+c.toString()).slice(-1000));
const chain={id:31337,name:'Isolated custody deployment rehearsal',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[`http://127.0.0.1:${port}`]}}};
const pc=createPublicClient({chain,transport:http(chain.rpcUrls.default.http[0],{timeout:10000,retryCount:0})});
try{
 let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(error);try{ready=await pc.getChainId()===31337;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('fork did not become ready');
 const key=JSON.parse(fs.readFileSync(dir+'/deployer.json')).privateKey,account=privateKeyToAccount(key);
 if(account.address!==plan.deployer)throw Error('wrong rehearsal account');
 await pc.request({method:'anvil_setBalance',params:[account.address,'0x'+parseEther('1').toString(16)]});
 const wc=createWalletClient({account,chain,transport:http(chain.rpcUrls.default.http[0])});
 const txs=[];
 for(const tx of plan.transactions){
  const gas=await pc.estimateGas({account,data:tx.data});
  const receipt=await pc.waitForTransactionReceipt({hash:await wc.sendTransaction({data:tx.data,nonce:tx.nonce,gas:gas*12n/10n}),timeout:60000});
  if(receipt.status!=='success'||receipt.contractAddress.toLowerCase()!==tx.address.toLowerCase())throw Error('deployment mismatch');
  txs.push({name:tx.name,address:tx.address,gasEstimate:String(gas),gasUsed:String(receipt.gasUsed),transactionHash:receipt.transactionHash});
  fs.writeFileSync(dir+'/rehearsal-transactions.json',JSON.stringify(txs,null,2));
  console.log('Fork deployed',tx.name,String(receipt.gasUsed));
 }
 const blk=await pc.getBlock({blockTag:'latest'});
 const verified=await verifyIndependentAuthorities({artifacts,plan,...authorityReads(pc,blk.hash)});
 const config=JSON.parse(fs.readFileSync('/home/steven/Projects/enclave/metal/config.json'));
 const hostId=keccak256(toBytes(config.publicUrl));
 const reg=await pc.readContract({address:plan.inputs.registry,abi:REGISTRY_V4_ABI,functionName:'get',args:[hostId]});
 if(!reg.active)throw Error('fork host not active');
 const ownership=plan.addresses.EnclaveHostOwnership,abi=artifacts.contracts.EnclaveHostOwnership.abi;
 let denied=false;try{await pc.simulateContract({account,address:ownership,abi,functionName:'proposeOwner',args:[hostId,plan.inputs.enclaveOwner]});}catch{denied=true;}if(!denied)throw Error('foreign operator was accepted');
 for(const sender of [reg.operator,plan.inputs.enclaveOwner])await pc.request({method:'anvil_impersonateAccount',params:[sender]});
 for(const sender of [reg.operator,plan.inputs.enclaveOwner])await pc.request({method:'anvil_setBalance',params:[sender,'0x'+parseEther('1').toString(16)]});
 for(const [sender,functionName,args] of [[reg.operator,'proposeOwner',[hostId,plan.inputs.enclaveOwner]],[plan.inputs.enclaveOwner,'acceptOwner',[hostId]]]){
  const w=createWalletClient({account:sender,chain,transport:http(chain.rpcUrls.default.http[0])});
  const hash=await w.writeContract({address:ownership,abi,functionName,args,nonce:await pc.getTransactionCount({address:sender,blockTag:'latest'})});
  await pc.request({method:'evm_mine',params:[]});
  const rc=await pc.waitForTransactionReceipt({hash,timeout:30000});if(rc.status!=='success')throw Error('fork ownership test failed');
 }
 const accepted=await pc.readContract({address:ownership,abi,functionName:'authority',args:[hostId]});if(accepted[0].toLowerCase()!==plan.inputs.enclaveOwner.toLowerCase())throw Error('owner acceptance mismatch');
 await pc.request({method:'anvil_setCode',params:['0xab214342d5A490150A4A977063A2f88E21F80907','0x']});
 const after=await pc.getBlock({blockTag:'latest'});await verifyIndependentAuthorities({artifacts,plan,...authorityReads(pc,after.hash)});
 const result={forkBlock:String(preflight.blockNumber),forkChainId:31337,transactions:txs,verified,liveRegistryOwnerAcceptance:true,foreignOperatorRejected:true,bindingsSurviveMutableBookDeletion:true,productionTransactionsSent:0};
 fs.writeFileSync(dir+'/rehearsal.json',JSON.stringify(result,null,2));console.log('Fork runtime/immutable/ownership verification passed');
}finally{if(child.exitCode===null){const end=once(child,'exit');child.kill('SIGTERM');await end;}}
