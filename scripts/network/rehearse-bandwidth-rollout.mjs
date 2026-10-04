#!/usr/bin/env node
// Production state, production bytecode, local execution only. Never accepts a
// private key or a remote write endpoint. Fork impersonation is confined to the
// child Anvil instance. This is a rehearsal, not an activation tool.
import fs from 'node:fs/promises';
import net from 'node:net';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,encodeFunctionData,stringToHex,parseAbi,keccak256} from 'viem';
import {base} from 'viem/chains';
import {CONTRACTS} from '../../site/js/gen/contract-artifacts.js';
import {linkBytecode} from '../../site/js/lib/contract-linker.js';
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i<0?d:process.argv[i+1];};
const audit=JSON.parse(await fs.readFile(arg('--audit','../current-bandwidth-rollout-audit.json'),'utf8'));
const rpc=arg('--rpc','https://base-rpc.publicnode.com');
if(new URL(rpc).protocol!=='https:'||audit.chainId!==8453)throw Error('Base HTTPS snapshot required');
const upstream=createPublicClient({chain:base,transport:http(arg('--read-rpc','https://base-rpc.publicnode.com'))});
assert.equal((await upstream.getBlock({blockNumber:BigInt(audit.blockNumber)})).hash,audit.blockHash,'audit block changed');
assert.equal(audit.verification.policies.length,0,'verification policies need a separate owner-authorized migration');
assert.equal(audit.verification.jobs.length,0,'verification jobs must complete before this cutover');
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const proc=spawn(process.env.ANVIL||'anvil',['--host','127.0.0.1','--port',String(port),'--fork-url',rpc,'--fork-block-number',audit.blockNumber,'--chain-id','8453','--compute-units-per-second','50','--silent'],{stdio:['ignore','ignore','pipe']});
let childError='';proc.stderr.on('data',b=>{childError=(childError+b).slice(-4000);});
const transport=http(`http://127.0.0.1:${port}`,{timeout:60000}),client=createPublicClient({chain:base,transport,pollingInterval:100});
const feeQuote=await upstream.estimateFeesPerGas(),feePolicy={maxPriorityFeePerGas:feeQuote.maxPriorityFeePerGas,maxFeePerGas:feeQuote.maxFeePerGas*2n};
const governance=audit.params.owner,wallet=createWalletClient({chain:base,account:governance,transport});
const abis={},libraries={},transactions=[];
const abi=async name=>abis[name]??=JSON.parse(await fs.readFile(new URL(`../../contracts/${name}.abi.json`,import.meta.url),'utf8'));
const read=async(address,name,functionName,args=[])=>client.readContract({address,abi:await abi(name),functionName,args});
const record=async(hash,label)=>{const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success',label);transactions.push({label,hash,gasUsed:String(receipt.gasUsed)});console.error(label+' confirmed on local fork');return receipt;};
const send=async(address,name,functionName,args=[])=>{const data=encodeFunctionData({abi:await abi(name),functionName,args});const gas=await client.estimateGas({account:governance,to:address,data});return record(await wallet.sendTransaction({...feePolicy,to:address,data,gas:gas*12n/10n+10000n}),functionName);};
async function deploy(name,args=[]){
 const a=CONTRACTS[name];
 for(const key of Object.keys(a.libraries||{}))if(!libraries[key]){
  const l=a.libraries[key];assert.deepEqual(l.linkReferences,{},'nested library needs explicit ordering');
  const gas=await client.estimateGas({account:governance,data:l.bytecode});
  libraries[key]=(await record(await wallet.sendTransaction({...feePolicy,data:l.bytecode,gas:gas*12n/10n}),'deploy '+key)).contractAddress;
 }
 const bytecode=linkBytecode(a.bytecode,a.linkReferences,libraries);
 const hash=await wallet.deployContract({...feePolicy,abi:await abi(name),bytecode,args,gas:14500000n});
 return (await record(hash,'deploy '+name)).contractAddress;
}
try{
 for(let i=0;i<200;i++){if(proc.exitCode!==null)throw Error(childError);try{await client.getChainId();break;}catch{await new Promise(r=>setTimeout(r,100));}}
 assert.equal(await client.getChainId(),8453);
 await client.request({method:'anvil_impersonateAccount',params:[governance]});
 // Impersonation authorizes only the disposable local fork. No balance edits:
 // deployment gas and escrow funding must fit the actual governance balances.
 const old=audit.entries.deployments,p=audit.params;
 assert.equal((await read(audit.book,'EnclaveAddressBook','owner')).toLowerCase(),governance.toLowerCase());
 const sourceRead=async(functionName,args=[])=>upstream.readContract({address:old,abi:await abi('EnclaveDeployments'),functionName,args,blockNumber:BigInt(audit.blockNumber)});
 const count=await sourceRead('count'),rows=[];
 for(let i=0n;i<count;i+=25n)rows.push(...await sourceRead('getPage',[i,25n]));
 const side=[];
 for(let i=0;i<rows.length;i+=20){const batch=rows.slice(i,i+20);const result=await upstream.multicall({blockNumber:BigInt(audit.blockNumber),allowFailure:false,batchSize:16384,contracts:batch.flatMap(r=>['feeOf','earnOf','capOf','ownerEscrow6'].map(functionName=>({address:old,abi:abis.EnclaveDeployments,functionName,args:[r.id]})))});for(let j=0;j<batch.length;j++)side.push({id:batch[j].id,fee:result[j*4],earn:result[j*4+1],cap:result[j*4+2],ownerEscrow:result[j*4+3]});}
 console.error('Pinned production snapshot loaded');
 // Freezing the source is irreversible on mainnet and belongs in the final
 // maintenance window, after independently operated routes and signers exist.
 await send(old,'EnclaveDeployments','retire');
 const ledger=await deploy('EnclaveDeployments',[p.usdc,p.payout,p.registry,p.ethUsdFeed]);
 const proof=await deploy('EnclaveProofOfTime',[ledger,p.registry]);
 await send(ledger,'EnclaveDeployments','setProver',[proof]);
 const fees=await deploy('EnclaveVerificationFees',[ledger,proof]);
 await send(ledger,'EnclaveDeployments','setFeeRouter',[fees]);
 // Deterministic fixture addresses are deliberately NOT claimed to be real
 // independent probe operators. Production must supply their actual keys.
 const probeFixtures=['0x'+'71'.repeat(20),'0x'+'72'.repeat(20)];
 const connectivity=await deploy('EnclaveConnectivity',[ledger,probeFixtures]);
 await send(ledger,'EnclaveDeployments','setBandwidthRouter',[connectivity]);
 for(const [fn,args] of [ ['setLeaseSec',[BigInt(p.leaseSec)]],['setMaxGpuMilli',[Number(p.maxGpuMilli)]],['setMaxFee',[BigInt(p.maxFeePerSec6)]],['setRunnerBps',[Number(p.runnerBps)]],['setClaimBond',[BigInt(p.claimBond6),BigInt(p.bondExitDelay)]],['setProofRequiredFrom',[BigInt(p.proofRequiredFrom)]] ])await send(ledger,'EnclaveDeployments',fn,args);
 await send(proof,'EnclaveProofOfTime','setProofWindow',[BigInt(audit.proofParams.proofWindowSec)]);
 for(let i=0;i<rows.length;i+=4)await send(ledger,'EnclaveDeployments','importDeployments',[rows.slice(i,i+4)]);
 const feeRows=side.filter(x=>x.fee[1]>0n),earnRows=side.filter(x=>x.earn[0]>0n);
 if(feeRows.length)await send(ledger,'EnclaveDeployments','importFees',[feeRows.map(x=>x.id),feeRows.map(x=>x.fee[0]),feeRows.map(x=>x.fee[1])]);
 if(earnRows.length)await send(ledger,'EnclaveDeployments','importEarn',[earnRows.map(x=>x.id),earnRows.map(x=>x.earn[0])]);
 await send(ledger,'EnclaveDeployments','importCaps',[side.map(x=>x.id),side.map(x=>x.cap)]);
 const backed=rows.filter(r=>r.active&&r.balance6>0n),backing=backed.reduce((n,r)=>n+r.balance6,0n);
 const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function approve(address,uint256) returns(bool)']);
 const heldBefore=await client.readContract({address:p.usdc,abi:tokenAbi,functionName:'balanceOf',args:[old]});
 await record(await wallet.writeContract({...feePolicy,address:p.usdc,abi:tokenAbi,functionName:'approve',args:[ledger,backing]}),'approve exact escrow');
 for(const r of backed)await send(ledger,'EnclaveDeployments','fundEscrow',[r.id,r.balance6]);
 for(const [i,source] of rows.entries()){
  const target=await read(ledger,'EnclaveDeployments','get',[source.id]);
  assert.deepEqual(target,{...source,runner:'0x'+'00'.repeat(32),runnerOperator:'0x'+'00'.repeat(20),leaseUntil:0n},'deployment '+source.id);
  assert.deepEqual(await read(ledger,'EnclaveDeployments','feeOf',[source.id]),side[i].fee);
  assert.equal((await read(ledger,'EnclaveDeployments','earnOf',[source.id]))[0],side[i].earn[0]);
  assert.equal(await read(ledger,'EnclaveDeployments','capOf',[source.id]),side[i].cap);
  assert.equal(await read(old,'EnclaveDeployments','ownerEscrow6',[source.id]),side[i].ownerEscrow,'old refund rights');
  if(source.active)assert.equal(await read(ledger,'EnclaveDeployments','bandwidthBackingRequired6',[source.id]),0n);
 }
 assert.equal(await client.readContract({address:p.usdc,abi:tokenAbi,functionName:'balanceOf',args:[old]}),heldBefore,'old backing unchanged');
 assert.equal(await client.readContract({address:p.usdc,abi:tokenAbi,functionName:'balanceOf',args:[ledger]}),backing);
 await send(ledger,'EnclaveDeployments','sealImports');
 const entries={deployments:ledger,proofOfTime:proof,verificationFees:fees,connectivity};
 await send(audit.book,'EnclaveAddressBook','setMany',[Object.keys(entries).map(k=>stringToHex(k,{size:32})),Object.values(entries)]);
 for(const [key,address] of Object.entries(entries))assert.equal((await read(audit.book,'EnclaveAddressBook','addr',[stringToHex(key,{size:32})])).toLowerCase(),address.toLowerCase());
 for(const field of ['leaseSec','maxGpuMilli','maxFeePerSec6','runnerBps','claimBond6','bondExitDelay','proofRequiredFrom'])assert.equal(String(await read(ledger,'EnclaveDeployments',field)),String(p[field]),field);
 assert.equal(await read(ledger,'EnclaveDeployments','importsSealed'),true);
 assert.equal(await read(ledger,'EnclaveDeployments','deploymentsSchema'),16n);
 const result={passed:true,productionActivated:false,localForkOnly:true,sourceBlock:audit.blockNumber,sourceHash:audit.blockHash,records:rows.length,active:rows.filter(r=>r.active).length,backingUSDC6:String(backing),oldRefundRightsPreserved:true,oldBackingPreserved:true,exactStateVerified:true,paramsPreserved:true,proofAndFeesBound:true,bookUpdatedAtomically:true,gasModel:'Base execution fee quote; Anvil does not model Base L1 data fees',probeOperators:'fixtures; real independent operators still required',artifactHashes:Object.fromEntries(Object.entries(entries).map(([k])=>[k,keccak256(CONTRACTS[{deployments:'EnclaveDeployments',proofOfTime:'EnclaveProofOfTime',verificationFees:'EnclaveVerificationFees',connectivity:'EnclaveConnectivity'}[k]].bytecode.replace(/__\$[a-f0-9]{34}\$__/g,'0'.repeat(40)))])),transactions};
 console.log(JSON.stringify(result,null,2));
}catch(e){console.error(e.shortMessage||e.message);if(e.details)console.error(e.details.slice(0,1000));process.exitCode=1;}finally{if(proc.exitCode===null){proc.kill('SIGTERM');await new Promise(r=>proc.once('exit',r));}}
