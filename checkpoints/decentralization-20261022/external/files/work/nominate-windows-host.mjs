import fs from 'node:fs';import assert from 'node:assert/strict';import{createRequire}from'node:module';
import{loadOperator}from'file:///C:/Program%20Files/Enclave/control/windows/node/chain.mjs';
const require=createRequire('C:/Program Files/Enclave/control/windows/node/package.json');const{createPublicClient,createWalletClient,http,parseAbi,keccak256}=require('viem');const{base}=require('viem/chains');
const contract='0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7',registry='0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac',host='0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a',owner='0x0b2d009c0c9af05b12100d77f3c815fea822ee61',operator='0x1a01194c34fe3577c6d0a54feb78af6253e494e0',zero='0x'+'0'.repeat(40),file='C:/ProgramData/Enclave/nan-retirement/host-nomination-state.json';
const abi=parseAbi(['function registry() view returns(address)','function authority(bytes32) view returns(address owner,address pendingOwner,uint64 revision,bytes32 policyHash)','function proposeOwner(bytes32,address)']);
async function main(){
 const c=createPublicClient({chain:base,transport:http('https://base.drpc.org')});assert.equal(await c.getChainId(),8453);assert.equal(keccak256(await c.getCode({address:contract})),'0xe38a0e160dd929c366bccd30636285458c288ada475f1b74ffc3289febf1d5dd');assert.equal((await c.readContract({address:contract,abi,functionName:'registry'})).toLowerCase(),registry);
 const a=await c.readContract({address:contract,abi,functionName:'authority',args:[host]});assert.ok([zero,owner].includes(a[0].toLowerCase()));assert.ok([zero,owner].includes(a[1].toLowerCase()));
 if(a[0].toLowerCase()===owner||a[1].toLowerCase()===owner){console.log(JSON.stringify({status:'already-nominated-or-accepted',owner:a[0],pendingOwner:a[1]}));return;}
 const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
 if(previous&&!previous.hash)throw Error('previous attempt uncertain; inspect before retry');
 let hash=previous?.hash;
 if(!hash){
  const account=loadOperator('C:/ProgramData/Enclave/node/operator.key');assert.equal(account.address.toLowerCase(),operator);
  const nonce=await c.getTransactionCount({address:operator,blockTag:'pending'});assert.equal(nonce,await c.getTransactionCount({address:operator,blockTag:'latest'}),'operator has a pending transaction');
  const{request}=await c.simulateContract({account,address:contract,abi,functionName:'proposeOwner',args:[host,owner]});
  fs.writeFileSync(file,JSON.stringify({status:'submitting',nonce,host,owner}));
  hash=await createWalletClient({account,chain:base,transport:http('https://base.drpc.org')}).writeContract({...request,nonce});
  fs.writeFileSync(file,JSON.stringify({status:'submitted',hash,nonce,host,owner}));
 }
 const receipt=await c.waitForTransactionReceipt({hash,confirmations:2,timeout:60000});assert.equal(receipt.status,'success');
 const after=await c.readContract({address:contract,abi,functionName:'authority',args:[host]});assert.equal(after[1].toLowerCase(),owner);
 const result={status:'confirmed',hash,host,owner,contract,blockNumber:String(receipt.blockNumber),pendingOwner:after[1],walletAcceptanceRequired:true};fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(e=>{console.error(JSON.stringify({status:'failed',reason:e.shortMessage||e.message}));process.exitCode=1;});
