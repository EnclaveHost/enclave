import {randomInt,randomBytes} from 'node:crypto';
import {quoteVerification} from './pricing.mjs';

/** Produce offers, never transactions. The execution driver revalidates chain
 * budget, allocation, certificate and job hash immediately before funding.
 * All proposed work consumes reservations even before any transaction lands.
 */
export function planRound({observation, policy, previous, nowSec, durationSec,
  availableBudget6, allocationUnits, maxConcurrent, cooldownSec, history={},
  compatibleCustomerQueueUnits=0n, pick=randomInt}) {
  if(typeof allocationUnits!=='bigint'||allocationUnits<=0n || !Number.isInteger(maxConcurrent)
    || maxConcurrent<1||maxConcurrent>64||typeof cooldownSec!=='bigint'||cooldownSec<0n)
    throw new Error('invalid scheduling limits');
  if(compatibleCustomerQueueUnits>0n) return {offers:[],reason:'customer work has priority'};
  const seen=new Set();
  const candidates=observation.hosts.filter(h=>{
    if(seen.has(h.hardwareId)) return false; seen.add(h.hardwareId);
    const last=history[h.hardwareId];
    return h.spareUnits>=allocationUnits && h.expiresSec>nowSec+durationSec
      && (!last || (!last.pending && nowSec-BigInt(last.atSec)>=cooldownSec));
  }).map(h=>({h,at:BigInt(history[h.hardwareId]?.atSec||0)}));
  // Oldest checked first, random tie breaking. Hosts cannot request their own
  // repetitions. Persistent history is keyed by hardware rather than wallet.
  candidates.sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:0);
  const offers=[];let budget=availableBudget6;
  while(candidates.length && offers.length<maxConcurrent) {
    const oldest=candidates[0].at;
    const ties=candidates.findIndex(x=>x.at!==oldest);
    const count=ties<0?candidates.length:ties;
    const index=pick(count);if(!Number.isInteger(index)||index<0||index>=count)throw new Error('invalid chooser');
    const {h}=candidates.splice(index,1)[0];
    // The class policy is per normalized unit. The actual offer buys a fixed
    // allocation. Round shares UP, then price the actual resulting allocation.
    const shareMilli=(allocationUnits*1000n+h.units-1n)/h.units;
    const actualUnits=(h.units*shareMilli+999n)/1000n;
    if(shareMilli>1000n||actualUnits>h.spareUnits) continue;
    const scaled={...policy,anchorRate6:policy.anchorRate6*actualUnits,
      maximumRate6:policy.maximumRate6*actualUnits};
    const prior=previous?{...previous,rate6:previous.rate6*actualUnits}:null;
    const q=quoteVerification({observation,previous:prior,policy:scaled,nowSec,durationSec,
      availableBudget6:budget,hostMinimumRate6:h.minimumRate6*actualUnits,spareUnits:h.spareUnits});
    if(!q.accepted) continue;
    budget-=q.maximumSpend6;
    offers.push({...q,id:'0x'+randomBytes(32).toString('hex'),hostId:h.hostId,hardwareId:h.hardwareId,
      operator:h.operator,shareMilli,allocationUnits:actualUnits,capacityExpiresSec:h.expiresSec});
  }
  return {offers,reserved6:availableBudget6-budget,remaining6:budget};
}

/** Drive a persisted job exactly once through normal deployment operations.
 * Store.compareAndSet is an exclusive, durable transition. An ambiguous create
 * is reconciled by the adapter using the recorded transaction, never retried as
 * another create. No successful result is issued on an unconfirmed shutdown.
 */
export async function advanceJob(id,{store,chain,workload,nowSec}) {
  const job=await store.get(id);
  if(!job)throw new Error('unknown job');
  if(['complete','failed','expired'].includes(job.state))return job;
  if(job.state==='offered') {
    if(BigInt(job.offer.validUntilSec)<=nowSec) return store.transition(id,'offered',{state:'expired'});
    // Validate payer policy, identity and profile before creating the job.
    // fundOrRecover subsequently verifies the offer and exact authorization.
    await chain.validate(job);
    await store.transition(id,'offered',{state:'creating'});
    return advanceJob(id,{store,chain,workload,nowSec});
  }
  if(job.state==='creating') {
    const deployment=await chain.createOrRecover(job);
    await store.transition(id,'creating',{state:'funding',deployment});
    return advanceJob(id,{store,chain,workload,nowSec});
  }
  if(job.state==='funding') {
    if(BigInt(job.offer.validUntilSec)<=nowSec) return store.transition(id,'funding',{state:'stopping',failure:'funding deadline expired'});
    await chain.fundOrRecover(job);
    return store.transition(id,'funding',{state:'queued'});
  }
  if(job.state==='queued') {
    const lease=await chain.lease(job);
    if(!lease) {
      if(BigInt(job.offer.validUntilSec)<=nowSec) return store.transition(id,'queued',{state:'stopping',failure:'claim deadline expired'});
      return job;
    }
    if(String(lease.hostId).toLowerCase()!==String(job.offer.hostId).toLowerCase() || String(lease.operator).toLowerCase()!==String(job.offer.operator).toLowerCase() || BigInt(lease.rate6)>BigInt(job.offer.rate6))
      return store.transition(id,'queued',{state:'stopping',failure:'unexpected host or rate'});
    return store.transition(id,'queued',{state:'running',lease});
  }
  if(job.state==='running') {
    // Journal before network I/O: a crash cannot silently run the challenge
    // twice or select only the better observation after a failure.
    await store.transition(id,'running',{state:'checking'});
    try {
      const result=await workload.runAndVerify(job);
      if(result?.verified!==true)throw new Error('workload verification failed');
      return store.transition(id,'checking',{state:'stopping',result});
    } catch(e) {return store.transition(id,'checking',{state:'stopping',failure:String(e.message).slice(0,500)});}
  }
  if(job.state==='checking')
    return store.transition(id,'checking',{state:'stopping',failure:'interrupted verification; not a passing result'});
  if(job.state==='stopping') {
    if(await chain.stopAndReconcile(job)===false)return job; // deactivates normal job, releases lease and attempts normal refund
    return store.transition(id,'stopping',{state:job.failure?'failed':'complete'});
  }
  throw new Error('unknown state');
}
