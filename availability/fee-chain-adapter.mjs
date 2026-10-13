import fs from 'node:fs';import {decodeEventLog} from 'viem';
import {transactionJournal} from './transaction-journal.mjs';
const abi=n=>JSON.parse(fs.readFileSync(new URL(`../contracts/${n}.abi.json`,import.meta.url)));
const D=abi('EnclaveDeployments'),F=abi('EnclaveVerificationFees'),R=abi('EnclaveRegistry');
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
export function createFeeChainAdapter({publicClient,executorWallet,ledger,fees,registry,chainId,source,profile,store,stageSecrets,acceptHostOffer,claimHint,now=()=>BigInt(Math.floor(Date.now()/1000))}){
 const read=(address,abi,functionName,args=[])=>publicClient.readContract({address,abi,functionName,args});
 const tx=transactionJournal({store,publicClient});
 async function policy(){
  const p=await read(fees,F,'policies',[source]);
  const balance=await publicClient.readContract({address:await read(ledger,D,'usdc'),abi:[{type:'function',name:'balanceOf',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}],functionName:'balanceOf',args:[p[2]]});
  return {payer:p[0],executor:p[1],wallet:p[2],expires:p[3],epoch:p[4],bps:p[5],maxCpuMilli:p[6],dailyCap6:p[7],jobCap6:p[8],maxRate6:p[9],available6:p[10]<balance?p[10]:balance,appRef:p[11],backend:p[12]};
 }
 async function validate(job){
  if(await publicClient.getChainId()!==chainId)throw new Error('wrong chain');
  if(await read(ledger,D,'deploymentsSchema')<15n||!same(await read(ledger,D,'feeRouter'),fees)||!same(await read(fees,F,'ledger'),ledger))throw new Error('fee routing is not bound to this ledger');
  const p=await policy(),d=await read(ledger,D,'get',[source]);
  if(!same(p.executor,executorWallet.account.address)||!same(p.payer,d.owner)||p.expires<=now())throw new Error('inactive payer/executor policy');
  if(p.appRef!==profile.appRef||p.backend!==profile.isolationBackend||profile.classId!==job.offer.classId)throw new Error('unreviewed workload profile');
  if(BigInt(job.offer.shareMilli)>BigInt(p.maxCpuMilli)||BigInt(job.offer.rate6)>p.maxRate6||BigInt(job.offer.maximumSpend6)>p.jobCap6||BigInt(job.offer.maximumSpend6)>p.available6||BigInt(job.offer.validUntilSec)<=now())throw new Error('job exceeds payer policy');
  const host=await read(registry,R,'get',[job.offer.hostId]);
  if(!host.active||!same(host.operator,job.offer.operator)||same(host.payoutWallet,p.payer))throw new Error('ineligible host');
  if(typeof stageSecrets!=='function'||typeof acceptHostOffer!=='function')throw new Error('secret and host-offer adapters required');
  return p;
 }
 return {policy,validate,
  async createOrRecover(job){
   await validate(job);
   const receipt=await tx(job,'create',executorWallet,{address:fees,abi:F,functionName:'createJob',args:[source,job.offer.hostId,Number(job.offer.shareMilli),BigInt(job.offer.rate6),BigInt(job.offer.durationSec),BigInt(job.offer.validUntilSec),job.id]});
   for(const log of receipt.logs)if(same(log.address,fees)){
    let e;try{e=decodeEventLog({abi:F,data:log.data,topics:log.topics});}catch{continue;}
    if(e.eventName==='JobCreated'&&same(e.args.source,source)&&same(e.args.hostId,job.offer.hostId))return {id:e.args.job,createdTx:receipt.transactionHash};
   }throw new Error('no matching fee-funded job creation');
  },
  async fundOrRecover(job){
   const j=await read(fees,F,'jobs',[job.deployment.id]);if(j[7])return;
   await validate(job);await stageSecrets(job.deployment.id,{CAPACITY_WORK_TOKEN:job.token});
   await acceptHostOffer({id:job.deployment.id,hostId:job.offer.hostId,rate6:BigInt(job.offer.rate6),expiresSec:BigInt(job.offer.validUntilSec)});
   await tx(job,'fund',executorWallet,{address:fees,abi:F,functionName:'fundJob',args:[source,job.deployment.id]});
   if(claimHint)await claimHint(job.deployment.id,job.offer.hostId);
  },
  async lease(job){const d=await read(ledger,D,'get',[job.deployment.id]);return d.leaseUntil>now()&&!/^0x0+$/.test(d.runner)?{hostId:d.runner,operator:d.runnerOperator,rate6:d.rate,leaseUntil:d.leaseUntil}:null;},
  async stopAndReconcile(job){
   const before=await read(ledger,D,'get',[job.deployment.id]);
   if(!before.active&&before.leaseUntil>now()&&!/^0x0+$/.test(before.runner))return false;
   // A stop transaction may deactivate first and wait for a live runner. Each
   // confirmed cleanup round has a distinct journal key; uncertain ones do not.
   const current=await store.get(job.id),key='stop-'+(current.cleanupRound||0);
   await tx(job,key,executorWallet,{address:fees,abi:F,functionName:'stopJob',args:[job.deployment.id]});
   const d=await read(ledger,D,'get',[job.deployment.id]);
   const latest=await store.get(job.id);await store.transition(job.id,latest.state,{cleanupRound:(latest.cleanupRound||0)+1});
   return !d.active&&(d.leaseUntil<=now()||/^0x0+$/.test(d.runner))&&await read(ledger,D,'refundableOf',[job.deployment.id])===0n;
  }
 };
}
