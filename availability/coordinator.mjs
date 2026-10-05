import {randomBytes} from 'node:crypto';
import {planRound,advanceJob} from './scheduler.mjs';
import {quoteVerification} from './pricing.mjs';
const CONTROL='0x'+'00'.repeat(32);
const terminal=new Set(['complete','failed','expired']);
/** One round under openStore's exclusive lock. The observation loader must use
 * finalized paid-service accounting and independent capacity receipts. Wallet,
 * host-offer and attestation adapters are explicit deployment dependencies.
 * No controller is enabled merely by importing this module.
 */
export async function runRound({store,chain,workload,loadObservation,policy,scheduling,nowSec}) {
 if(typeof loadObservation!=='function')throw new Error('observation loader required');
 const errors=[];
 // Recovery/cleanup continues even after policy revocation or market outage.
 let jobs=(await store.list()).filter(j=>j.id!==CONTROL);
 await Promise.all(jobs.filter(j=>!terminal.has(j.state)).map(async job=>{
  try {await advanceJob(job.id,{store,chain,workload,nowSec});}
  catch(e){errors.push({id:job.id,error:String(e.message).slice(0,500)});}
 }));
 jobs=(await store.list()).filter(j=>j.id!==CONTROL);
 const pending=jobs.filter(j=>!terminal.has(j.state));
 const slots=scheduling.maxConcurrent-pending.length;
 if(policy.enabled!==true||slots<=0)return {created:[],pending:pending.length,errors};
 const observation=await loadObservation();
 const control=await store.get(CONTROL);
 const previous=control?.price?Object.fromEntries(Object.entries(control.price).map(([k,v])=>[k,k==='classId'?v:BigInt(v)])):null;
 if(previous&&observation.atSec<=previous.atSec)return {created:[],pending:pending.length,errors,reason:'observation already consumed'};
 const budget=await chain.policy();
 if(!budget.bps||BigInt(budget.expires)<=nowSec)return {created:[],pending:pending.length,errors,reason:'funding policy inactive'};
 // Already-funded jobs are deducted by the contract. Pending signatures reserve
 // funds here too, including ambiguous submissions (conservative double reserve).
 const reserved=pending.filter(j=>['offered','creating','funding'].includes(j.state))
  .reduce((n,j)=>n+BigInt(j.offer.maximumSpend6),0n);
 const available=BigInt(budget.available6)>reserved?BigInt(budget.available6)-reserved:0n;
 const boundedPolicy={...policy,maximumJobSpend6:policy.maximumJobSpend6<BigInt(budget.jobCap6)?policy.maximumJobSpend6:BigInt(budget.jobCap6)};
 const history={};
 for(const j of jobs) {
  const hardware=j.offer.hardwareId,at=BigInt(j.offer.atSec);
  const old=history[hardware];
  history[hardware]={atSec:old&&BigInt(old.atSec)>at?old.atSec:at,pending:old?.pending||!terminal.has(j.state)};
 }
 const plan=planRound({observation,policy:boundedPolicy,previous,nowSec,...scheduling,
  maxConcurrent:slots,availableBudget6:available,history,
  compatibleCustomerQueueUnits:observation.queuedDemandUnits});
 const unitPrice=quoteVerification({observation,previous,policy:boundedPolicy,nowSec,
  durationSec:scheduling.durationSec,availableBudget6:available,hostMinimumRate6:0n,spareUnits:1n});
 if(!unitPrice.accepted)return {created:[],pending:pending.length,errors,reason:unitPrice.reason};
 // Persist epoch before creating offers. A crash can omit offers; it cannot
 // duplicate assignments from the same observation after restart.
 const price={classId:unitPrice.classId,atSec:unitPrice.atSec,windowSec:unitPrice.windowSec,rate6:unitPrice.rate6};
 if(control)await store.transition(CONTROL,'controller',{price});
 else await store.create({id:CONTROL,state:'controller',price});
 for(const offer of plan.offers)await store.create({id:offer.id,state:'offered',offer,token:randomBytes(32).toString('hex')});
 return {created:plan.offers.map(q=>q.id),pending:pending.length+plan.offers.length,reserved6:plan.reserved6||0n,errors};
}
