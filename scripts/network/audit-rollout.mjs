#!/usr/bin/env node
// Read-only ledger migration and bandwidth-backing inventory. No signer loaded.
import fs from 'node:fs/promises';
import {createPublicClient,http,parseAbi,stringToHex} from 'viem';
import {base} from 'viem/chains';
const rpc=(process.env.BANDWIDTH_AUDIT_RPCS||'https://base-rpc.publicnode.com,https://base.drpc.org').split(',');
if(rpc.length<2||new Set(rpc.map(u=>new URL(u).hostname)).size!==rpc.length)throw Error('independent RPC hosts required');
const clients=rpc.map(u=>createPublicClient({chain:base,transport:http(u,{timeout:20000,retryCount:2})}));
const book='0xab214342d5A490150A4A977063A2f88E21F80907';
const bookAbi=parseAbi(['function addr(bytes32) view returns (address)','function owner() view returns (address)']);
const ledgerAbi=JSON.parse(await fs.readFile(new URL('../../contracts/EnclaveDeployments.abi.json',import.meta.url),'utf8'));
const feesAbi=JSON.parse(await fs.readFile(new URL('../../contracts/EnclaveVerificationFees.abi.json',import.meta.url),'utf8'));
const proofAbi=JSON.parse(await fs.readFile(new URL('../../contracts/EnclaveProofOfTime.abi.json',import.meta.url),'utf8'));
const tokenAbi=parseAbi(['function balanceOf(address) view returns (uint256)']);
const json=v=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x);
const heads=await Promise.all(clients.map(c=>c.getBlockNumber({cacheTime:0}))),blockNumber=heads.reduce((a,b)=>a<b?a:b)-3n;
async function snapshot(c){
 if(await c.getChainId()!==8453)throw Error('wrong chain');
 const block=await c.getBlock({blockNumber});if(Date.now()/1000-Number(block.timestamp)>120)throw Error('stale block');
 const multi=contracts=>c.multicall({blockNumber,allowFailure:false,batchSize:16384,contracts});
 const keys=['deployments','registry','proofOfTime','verificationFees','connectivity'];
 const addresses=await multi(keys.map(key=>({address:book,abi:bookAbi,functionName:'addr',args:[stringToHex(key,{size:32})]})));
 const entries=Object.fromEntries(keys.map((key,i)=>[key,addresses[i]]));
 const fields=async(address,abi,names)=>{const values=await multi(names.map(functionName=>({address,abi,functionName})));return Object.fromEntries(names.map((name,i)=>[name,values[i]]));};
 const read=(functionName,args=[])=>c.readContract({address:entries.deployments,abi:ledgerAbi,functionName,args,blockNumber});
 const params=await fields(entries.deployments,ledgerAbi,['owner','pendingOwner','payout','deploymentsSchema','runnerBps','usdc','registry','feeRouter','prover','importsSealed','count','leaseSec','maxGpuMilli','maxFeePerSec6','claimBond6','bondExitDelay','proofRequired','proofRequiredFrom','ethUsdFeed','retired']);
 const rows=[];for(let i=0n;i<params.count;i+=25n)rows.push(...await read('getPage',[i,25n]));
 const active=[];let required=0n;
 const activeRows=rows.filter(d=>d.active);
 const balances=await multi(activeRows.flatMap(d=>['earnOf','ownerEscrow6','refundableOf'].map(functionName=>({address:entries.deployments,abi:ledgerAbi,functionName,args:[d.id]}))));
 for(const [index,d] of activeRows.entries()){
  const [earn,ownerEscrow6,refundable6]=balances.slice(index*3,index*3+3);
  const [rate6,escrow6,creditedUntil]=earn;
  const reserve=d.leaseUntil>creditedUntil?(d.leaseUntil-creditedUntil)*rate6:0n;
  const nominal=d.balance6+reserve,backingGap6=nominal>escrow6?nominal-escrow6:0n;required+=backingGap6;
  active.push({id:d.id,owner:d.owner,runner:d.runner,balance6:d.balance6,spent6:d.spent6,leaseUntil:d.leaseUntil,rate6,escrow6,creditedUntil,ownerEscrow6,refundable6,fullBalanceBackingGap6:backingGap6});
 }
 const held=await c.readContract({address:params.usdc,abi:tokenAbi,functionName:'balanceOf',args:[entries.deployments],blockNumber});
 const proofParams=await fields(entries.proofOfTime,proofAbi,['owner','pendingOwner','deployments','registry','proofSchema','proofWindowSec']);
 const verification={bindings:{},policies:[],jobs:[]};
 const zero='0x0000000000000000000000000000000000000000';
 if(entries.verificationFees.toLowerCase()!==zero){
  verification.bindings=await fields(entries.verificationFees,feesAbi,['ledger','proof','token','FEE_BPS']);
  for(let i=0;i<rows.length;i+=20){
   const batch=rows.slice(i,i+20);
   const values=await c.multicall({blockNumber,allowFailure:false,batchSize:16384,contracts:batch.flatMap(d=>['policies','jobs'].map(functionName=>({address:entries.verificationFees,abi:feesAbi,functionName,args:[d.id]})))});
   for(let j=0;j<batch.length;j++)for(const [offset,name]of ['policies','jobs'].entries()){
    const outputs=feesAbi.find(f=>f.type==='function'&&f.name===name).outputs;
    const value=Object.fromEntries(outputs.map((field,k)=>[field.name,values[j*2+offset][k]]));
    if(value.wallet.toLowerCase()!==zero)verification[name].push({id:batch[j].id,...value});
   }
  }
  const wallets=[...new Set([...verification.policies,...verification.jobs].map(p=>p.wallet.toLowerCase()))];
  verification.walletBalances=await Promise.all(wallets.map(async wallet=>({wallet,balance6:await c.readContract({address:params.usdc,abi:tokenAbi,functionName:'balanceOf',args:[wallet],blockNumber})})));
 }
 if((await c.getBlock({blockNumber})).hash!==block.hash)throw Error('block reorganized');
 return {chainId:8453,blockNumber,blockHash:block.hash,timestamp:block.timestamp,book,entries,params,proofParams,verification,heldUSDC6:held,active,additionalBackingForAllActive6:required,
  migrationConstraints:['Preserve old-ledger earned balances and refund rights; they are not transferable by changing the address book.',
   'Snapshot leases and verification state immediately before cutover; reconcile writes since this audit.',
   'Fund the new ledger backing from platform funds; do not debit customers again.',
   'Hand contract administration to governance before activating address-book entries.',
   'Qualify providers with actual independent transport probes before advertising direct service.']};
}
const values=await Promise.all(clients.map(snapshot));if(values.some(v=>json(v)!==json(values[0])))throw Error('rollout audit RPC disagreement');
console.log(JSON.stringify(values[0],(_k,x)=>typeof x==='bigint'?x.toString():x,2));
