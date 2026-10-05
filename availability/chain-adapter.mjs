import fs from 'node:fs';
import {decodeEventLog} from 'viem';
const load=name=>JSON.parse(fs.readFileSync(new URL(`../contracts/${name}.abi.json`,import.meta.url)));
const ledgerAbi=load('EnclaveDeployments'),fundingAbi=load('EnclaveAvailability'),registryAbi=load('EnclaveRegistry');
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const authTypes={ReceiveWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},
 {name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},
 {name:'nonce',type:'bytes32'}]};

/** Real ledger adapter. Signers may be bounded local accounts or user-controlled
 * wallet clients. It never reads private keys or discovers/unlocks accounts.
 * stageSecrets is the existing authenticated per-deployment secret API.
 * acceptHostOffer is an explicit host-side policy callback, not a forged claim.
 */
export function createChainAdapter({publicClient,payerWallet,executorWallet,payerAccount,
 ledger,availability,registry,usdc,chainId,source,profile,store,stageSecrets,acceptHostOffer,claimHint,
 now=()=>BigInt(Math.floor(Date.now()/1000))}) {
 const read=(address,abi,functionName,args)=>publicClient.readContract({address,abi,functionName,args});
 let txQueue=Promise.resolve();
 async function transaction(job,key,wallet,request) {
  const go=async()=>{
   const current=await store.get(job.id);let saved=current.transactions?.[key];
   if(!saved) {
    await store.transition(job.id,current.state,{transactions:{...current.transactions,[key]:{status:'requested'}}});
    let hash;
    try {hash=await wallet.writeContract(request);} catch(e) {
     // Do not guess whether an RPC error happened before or after broadcast.
     // Reconciliation needs the actual transaction hash; never double-spend.
     throw new Error(`${key}: submission uncertain or rejected; reconcile before retry: ${e.shortMessage||e.message}`);
    }
    const latest=await store.get(job.id);
    saved={hash,status:'submitted'};
    await store.transition(job.id,latest.state,{transactions:{...latest.transactions,[key]:saved}});
   }
   if(!saved.hash)throw new Error(`${key}: unresolved submission; transaction hash required`);
   const receipt=await publicClient.waitForTransactionReceipt({hash:saved.hash,confirmations:2,timeout:60000});
   if(receipt.status!=='success')throw new Error(`${key}: transaction reverted`);
   return receipt;
  };
  const result=txQueue.then(go);txQueue=result.catch(()=>{});return result;
 }
 async function policy() {
  const p=await read(availability,fundingAbi,'policies',[source]);
  return {payer:p[0],executor:p[1],bps:p[2],expires:BigInt(p[3]),epoch:BigInt(p[4]),dailyCap6:p[5],jobCap6:p[6],available6:p[7]};
 }
 async function validate(job) {
  if(await publicClient.getChainId()!==chainId)throw new Error('wrong chain');
  if(await read(ledger,ledgerAbi,'deploymentsSchema',[])<14n)throw new Error('negotiated job pricing requires ledger revision 14');
  if(!same(await read(availability,fundingAbi,'ledger',[]),ledger))throw new Error('wrong funding ledger');
  const p=await policy(),sourceDeployment=await read(ledger,ledgerAbi,'get',[source]);
  if(!same(payerAccount.address,p.payer)||!same(sourceDeployment.owner,p.payer))throw new Error('payer/source ownership mismatch');
  if(!same(executorWallet.account.address,p.executor))throw new Error('wrong executor');
  if(!p.bps||p.expires<=now()||BigInt(job.offer.validUntilSec)<=now())throw new Error('expired policy or offer');
  const amount=BigInt(job.offer.maximumSpend6);
  if(amount<=0n||amount>p.available6||amount>p.jobCap6)throw new Error('insufficient authorized budget');
  const host=await read(registry,registryAbi,'get',[job.offer.hostId]);
  if(!host.active||!same(host.operator,job.offer.operator)||same(host.payoutWallet,p.payer))
   throw new Error('host identity changed or self-hosted reward');
  if(!profile.appRef.startsWith('catalog://')||profile.gpuMilli!==0||profile.classId!==job.offer.classId)
   throw new Error('unsupported workload profile');
  if(typeof stageSecrets!=='function'||typeof acceptHostOffer!=='function')throw new Error('host offer and authenticated secret adapters required');
  return p;
 }
 return {
  validate,policy,
  async createOrRecover(job) {
   const envelope=JSON.stringify({config:{requestTag:job.id},isolation:{require:profile.isolationBackend}});
   const args=[profile.appRef,0,Number(job.offer.shareMilli),8000,'',true,envelope,
    '0x0000000000000000000000000000000000000000',0n,BigInt(job.offer.rate6)];
   const receipt=await transaction(job,'create',payerWallet,{account:payerAccount,address:ledger,abi:ledgerAbi,functionName:'create',args});
   for(const log of receipt.logs)if(same(log.address,ledger)) {
    let event;try{event=decodeEventLog({abi:ledgerAbi,data:log.data,topics:log.topics});}catch{continue;}
    if(event.eventName==='Created'&&same(event.args.owner,payerAccount.address))return {id:event.args.id,createdTx:receipt.transactionHash};
   }
   throw new Error('no payer-owned creation event');
  },
  async fundOrRecover(job) {
   const id=job.deployment.id;
   if(await read(availability,fundingAbi,'fundedJob',[id]))return;
   const p=await validate(job);
   await stageSecrets(id,{CAPACITY_WORK_TOKEN:job.token});
   // The host signs offerJobRate itself, after applying its configured floor.
   await acceptHostOffer({id,hostId:job.offer.hostId,rate6:BigInt(job.offer.rate6),expiresSec:BigInt(job.offer.validUntilSec)});
   if(await read(ledger,ledgerAbi,'rateFor',[id,job.offer.hostId])!==BigInt(job.offer.rate6))throw new Error('host has not accepted offered rate');
   const expectedHash=await read(availability,fundingAbi,'jobHash',[id]);
   const current=await store.get(job.id);let auth=current.authorization;
   if(!auth) {
    const nonce=await read(availability,fundingAbi,'fundingNonce',[source,id,p.epoch,expectedHash]);
    const message={from:p.payer,to:availability,value:BigInt(job.offer.maximumSpend6),validAfter:now()-1n,
     validBefore:BigInt(job.offer.validUntilSec),nonce};
    const signature=await payerWallet.signTypedData({account:payerAccount,domain:{name:'USD Coin',version:'2',chainId,verifyingContract:usdc},
     types:authTypes,primaryType:'ReceiveWithAuthorization',message});
    auth={...message,signature,epoch:p.epoch,jobHash:expectedHash};
    await store.transition(job.id,current.state,{authorization:auth});
   }
   if(auth.jobHash!==expectedHash||BigInt(auth.epoch)!==p.epoch)throw new Error('funding authorization needs renewed review');
   await transaction(job,'fund',executorWallet,{address:availability,abi:fundingAbi,functionName:'fundJob',
    args:[source,id,p.epoch,expectedHash,BigInt(auth.value),BigInt(auth.validAfter),BigInt(auth.validBefore),auth.nonce,auth.signature]});
   if(claimHint)await claimHint(id,job.offer.hostId);
  },
  async lease(job) {
   const d=await read(ledger,ledgerAbi,'get',[job.deployment.id]);
   if(d.leaseUntil<=now()||/^0x0+$/.test(d.runner))return null;
   return {hostId:d.runner,operator:d.runnerOperator,rate6:d.rate,leaseUntil:d.leaseUntil};
  },
  async stopAndReconcile(job) {
   const id=job.deployment.id;let d=await read(ledger,ledgerAbi,'get',[id]);
   if(d.active)await transaction(job,'stop',payerWallet,{account:payerAccount,address:ledger,abi:ledgerAbi,functionName:'setActive',args:[id,false]});
   d=await read(ledger,ledgerAbi,'get',[id]);
   if(d.leaseUntil>now()&&!/^0x0+$/.test(d.runner))return false;
   const refund=await read(ledger,ledgerAbi,'refundableOf',[id]);
   if(refund>0n)await transaction(job,'refund',payerWallet,{account:payerAccount,address:ledger,abi:ledgerAbi,functionName:'refund',args:[id]});
   return true;
  }
 };
}
