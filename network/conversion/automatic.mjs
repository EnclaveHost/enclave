import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DurableState} from '../durable-state.mjs';
import {ASSETS,conversionIntent,validatePolicy,validateQuote,units} from './policy.mjs';

const queues=new Map();

// One process owns this directory and its funding wallets. route is a reviewed
// adapter, not an API response: quote, open, lookup and status must preserve the
// exact order terms. wallet prepares but does not broadcast in prepareTransfer;
// verifyTransfer independently checks destination-chain finality and transfer.
export class AutomaticConversion {
 constructor({directory,policy,addresses,route,wallet,now=Date.now}){
  this.policy=validatePolicy(policy);this.addresses={...addresses};
  for(const currency of ['USDC','NKN'])if(!addresses[currency])throw Error('provider-owned destination required');
  this.route=route;this.wallet=wallet;this.now=now;this.store=new DurableState(directory);this.queueKey=path.resolve(directory);
 }
 tick(){const run=(queues.get(this.queueKey)||Promise.resolve()).then(()=>this.run());const tail=run.catch(()=>{});queues.set(this.queueKey,tail);void tail.then(()=>{if(queues.get(this.queueKey)===tail)queues.delete(this.queueKey);});return run;}
 async save(s){await this.store.set('conversion',s);return s;}
 async run(){
  let s=await this.store.get('conversion')||{version:1,days:{},usedTransfers:{},job:null};
  if(s.version!==1||!s.days||!s.usedTransfers)throw Error('damaged conversion journal');
  if(s.job)return this.resume(s);
  if(this.now()>=this.policy.expiresAt)return {state:'disabled',reason:'policy_expired'};
  const balances=await this.wallet.balances(this.addresses),intent=conversionIntent(this.policy,balances,this.now());
  if(!intent)return {state:'ready'};
  const quote=await this.route.quote({...intent,addresses:this.addresses});
  if(!quote)return {state:'unavailable',reason:'no_conversion_route'};
  const terms=validateQuote(quote,{policy:this.policy,intent,addresses:this.addresses,now:this.now()});
  const day=String(Math.floor(this.now()/86400000)),spent=units(s.days[day]||'0');
  if(spent+units(terms.cost)>units(this.policy.dailyConversionUsdc6))return {state:'limited',reason:'daily_limit'};
  // Reserve before the first side effect. Reservations stay charged even on a
  // refund: retries must not silently bypass the owner's daily spend limit.
  s.days[day]=String(spent+units(terms.cost));
  s.job={id:randomUUID(),phase:'opening',intent,quote,terms,addresses:this.addresses,createdAt:this.now()};
  await this.save(s);
  const order=await this.route.open({key:s.job.id,quote});
  this.checkOrder(s.job,order);s.job.order=order;s.job.phase='ordered';await this.save(s);
  return this.resume(s);
 }
 checkOrder(job,order){
  if(!order||typeof order.id!=='string'||!order.id||order.quoteId!==job.quote.id||order.amountIn!==job.quote.amountIn||order.inputAsset!==job.quote.inputAsset||order.outputAsset!==job.quote.outputAsset||order.recipient!==job.quote.recipient||order.refundAddress!==job.quote.refundAddress||order.minimumOut!==job.quote.minimumOut||order.minimumEnforced!==true||typeof order.depositAddress!=='string'||!order.depositAddress||order.expiresAt!==job.quote.expiresAt)throw Error('conversion order changed quoted terms');
 }
 async resume(s){
  const job=s.job;
  if(!['opening','ordered','prepared','funded','needs_review'].includes(job.phase))throw Error('invalid conversion journal phase');
  if(job.phase==='needs_review')return {state:'needs_review'};
  if(job.phase==='opening'){
   // An ambiguous create response must never cause a second deposit order.
   const order=await this.route.lookup({key:job.id});
   if(!order)return {state:'pending',reason:'order_reconciliation'};
   this.checkOrder(job,order);job.order=order;job.phase='ordered';await this.save(s);
  }
  if(job.phase==='ordered'){
   try{validateQuote(job.quote,{policy:this.policy,intent:job.intent,addresses:this.addresses,now:this.now()});}
   catch(e){s.last={id:job.id,state:'cancelled',reason:e.message};s.job=null;await this.save(s);return {state:'cancelled'};}
   await this.wallet.validateAddress(job.terms.input,job.order.depositAddress);
   const transfer={asset:job.quote.inputAsset,from:job.addresses[job.terms.input],to:job.order.depositAddress,amount:job.quote.amountIn};
   // Local wallet adapters must enforce the quote's all-in fee cap and keep
   // these wallets separate from application escrow and shared gas signers.
   const signed=await this.wallet.prepareTransfer({key:job.id,transfer,allInUsdc6:job.quote.allInUsdc6,minimumOut:job.quote.minimumOut,minUsdcPerNkn6:this.policy.minUsdcPerNkn6});
   if(!signed?.raw||!signed.hash)throw Error('funding transaction was not prepared');
   await this.wallet.validatePrepared({signed,transfer,allInUsdc6:job.quote.allInUsdc6,minimumOut:job.quote.minimumOut,minUsdcPerNkn6:this.policy.minUsdcPerNkn6});
   job.funding={...signed,transfer};job.phase='prepared';await this.save(s);
  }
  if(job.phase==='prepared'){
   // The same signed bytes survive uncertain broadcasts and process restarts.
   await this.wallet.validatePrepared({signed:job.funding,transfer:job.funding.transfer,allInUsdc6:job.quote.allInUsdc6,minimumOut:job.quote.minimumOut,minUsdcPerNkn6:this.policy.minUsdcPerNkn6,checkCurrentFees:false});
   const found=await this.wallet.fundingStatus(job.funding);
   if(found==='reverted'){s.last={id:job.id,state:'failed',reason:'funding_reverted'};s.job=null;await this.save(s);return {state:'failed'};}
   if(found!=='confirmed'){
    // Do not broadcast a previously unsent deposit to an expired quote. An
    // uncertain tx remains reserved until the local wallet reconciles it.
    if(this.now()>=job.quote.expiresAt||this.now()>=this.policy.expiresAt)return {state:'pending',reason:'funding_reconciliation'};
    await this.wallet.broadcast(job.funding);return {state:'pending',reason:'funding_confirmation'};
   }
   job.phase='funded';await this.save(s);
  }
  const report=await this.route.status({order:job.order});
  if(!report||!['received','refunded'].includes(report.state))return {state:'pending',reason:'conversion_confirmation'};
  if(typeof report.hash!=='string'||!report.hash)throw Error('destination transaction missing');
  const refund=report.state==='refunded',currency=refund?job.terms.input:job.terms.output;
  const recipient=job.addresses[currency],asset=ASSETS[currency].id;
  const proof=await this.wallet.verifyTransfer({asset,recipient,hash:report.hash,notBefore:job.createdAt});
  // A provider's "complete" response or an unrelated wallet balance increase
  // cannot manufacture conversion proceeds.
  if(!proof||proof.finalized!==true||proof.asset!==asset||proof.recipient!==recipient||typeof proof.transferId!=='string'||!proof.transferId||proof.hash!==report.hash||!Number.isSafeInteger(proof.timestamp)||proof.timestamp<job.createdAt||proof.timestamp>this.now()+5000)throw Error('destination transfer is not verified');
  const key=asset+':'+proof.transferId;
  if(Object.hasOwn(s.usedTransfers,key))throw Error('destination transfer already used');
  const amount=units(proof.amount,{zero:false});s.usedTransfers[key]=job.id;
  const minimum=units(refund?job.quote.amountIn:job.quote.minimumOut);
  const state=amount>=minimum?(refund?'refunded':'completed'):'needs_review';
  s.last={id:job.id,state,asset,amount:String(amount),transferId:proof.transferId};
  // A short payment remains blocked for operator reconciliation, never retried
  // as a fresh conversion and never credited at the expected amount.
  if(state==='needs_review'){job.phase='needs_review';await this.save(s);return {state:'needs_review'};}
  s.job=null;await this.save(s);return {state};
 }
}
