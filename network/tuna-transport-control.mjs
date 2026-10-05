// The local side of the USDC TUNA handshake. Private proof keys stay outside
// guarded workers. Public peers get only lease-bound signatures and receipts.
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {encodeAbiParameters,keccak256,recoverMessageAddress} from 'viem';
import {DurableState} from './durable-state.mjs';
import {tunaContext,TunaReceiptSigner} from './tuna-usdc-settlement.mjs';
import {meterKey,bandwidthABI} from './usdc-bandwidth.mjs';
const idPattern=/^0x[0-9a-f]{64}$/;
const uint=/^(0|[1-9][0-9]*)$/;
const GIB=1n<<30n,ceil=n=>(n+GIB-1n)/GIB;
const serialize=v=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?String(x):x);
function digest(terms,transcript){
 const fields=[['chainId','uint256'],['connectivity','address'],['ledger','address'],['deploymentId','bytes32'],['runnerId','bytes32'],['providerId','bytes32'],['nonce','uint64'],['leaseUntil','uint64'],['rate','uint64'],['issuedAt','uint64']];
 return keccak256(encodeAbiParameters([{type:'string'},...fields.map(([,type])=>({type})),{type:'bytes32'},{type:'bytes32'},{type:'bytes'}],['EnclaveTuna.session.v1',...fields.map(([key,type])=>type.startsWith('uint')?BigInt(terms[key]):terms[key]),'0x'+transcript.clientKey,'0x'+transcript.providerKey,'0x'+transcript.nonce]));
}
function transcript(value){
 if(!value||typeof value.server!=='boolean'||!/^([0-9a-f]{64})$/.test(value.clientKey||'')||!/^([0-9a-f]{64})$/.test(value.providerKey||'')||!/^([0-9a-f]{64})$/.test(value.nonce||''))throw Error('invalid authenticated transport transcript');
 return value;
}
export class TunaTransportController {
 constructor({role,hostId,proofAccount,leaseReader,directory,maxPending6,settlementFactory,now=Date.now}){
  if(!['runner','provider'].includes(role)||!idPattern.test(hostId)||!uint.test(maxPending6||'')||BigInt(maxPending6)<=0n||BigInt(maxPending6)>1000000000n)throw Error('bounded USDC transport credit and role required');
  if(role==='runner'&&typeof settlementFactory!=='function')throw Error('runner settlement required');
  Object.assign(this,{role,hostId,proofAccount,leaseReader,now,settlementFactory,maxPending6:BigInt(maxPending6)});
  this.store=new DurableState(path.join(directory,'transport'));this.sessions=new Map();this.reservations=new Map();this.queues=new Map();this.settlements=new Map();this.closed=false;this.paymentCache=new Map();this.opening=0;this.lastPruned=0;
 }
 async chainBytes(lease,providerId){
  const cacheKey=lease.id+':'+providerId+':'+lease.connectivity.nonce+':'+lease.blockHash;
  if(this.paymentCache.has(cacheKey))return this.paymentCache.get(cacheKey);
  const args={address:lease.connectivity.address,abi:bandwidthABI,functionName:'bytesServed',args:[meterKey(lease.id,providerId,lease.connectivity.nonce)],blockNumber:BigInt(lease.blockNumber)};
  const values=await Promise.all(this.leaseReader.clients.map(c=>c.readContract(args).then(String).catch(()=>null)));
  for(const value of values)if(value!==null&&values.filter(x=>x===value).length>=2){if(this.paymentCache.size>1024)this.paymentCache.clear();this.paymentCache.set(cacheKey,BigInt(value));return BigInt(value);}
  throw Error('transport payment quorum unavailable');
 }
 context(terms){
  const x=tunaContext(this.leaseReader.get(terms.deploymentId),terms.providerId,terms.nonce,terms.rate,this.now()),{lease,c,provider}=x;
  if(lease.runner!==terms.runnerId||BigInt(Math.floor(lease.leaseUntil/1000))<BigInt(terms.leaseUntil)||String(lease.chainId)!==terms.chainId||c.address.toLowerCase()!==terms.connectivity||lease.deployments.toLowerCase()!==terms.ledger)throw Error('transport lease or settlement contract changed');
  const signer=this.role==='runner'?lease.runnerProofKey:provider.proofKey;
  if(signer?.toLowerCase()!==this.proofAccount.address.toLowerCase()||(this.role==='runner'?lease.runner:provider.id)!==this.hostId)throw Error('transport controller identity mismatch');
  return x;
 }
 key(t){return keccak256(encodeAbiParameters([{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'uint64'}],[t.deploymentId,t.runnerId,t.providerId,BigInt(t.nonce)])).slice(2);}
 serial(key,fn){const run=(this.queues.get(key)||Promise.resolve()).then(fn),tail=run.catch(()=>{});this.queues.set(key,tail);void tail.then(()=>{if(this.queues.get(key)===tail)this.queues.delete(key)});return run;}
 async meter(t){
  const key=this.key(t),{lease}=this.context(t);
  let s=await this.store.get(key);
  if(!s){const base=await this.chainBytes(lease,t.providerId);s={version:1,base:String(base),in:'0',out:'0',rate:t.rate};await this.store.set(key,s);}
  if(s.version!==1||s.rate!==t.rate||!['base','in','out'].every(k=>uint.test(s[k])))throw Error('damaged transport meter');
  return s;
 }
 total(s){return BigInt(s.base)+BigInt(s.in)+BigInt(s.out);}
 async open(body){
  if(this.closed||this.sessions.size+this.opening>=1024)throw Error('transport controller unavailable');
  this.opening++;
  try{return await this.openSession(body);}finally{this.opening--;}
 }
 async openSession(body){
  const wire=transcript(body.transcript),server=this.role==='provider';if(wire.server!==server)throw Error('transport role mismatch');
  let terms,proof;
  if(server){terms=body.proof?.terms;if(!terms||!idPattern.test(terms.deploymentId)||terms.providerId!==this.hostId)throw Error('provider authorization missing');}
  else{
   if(!idPattern.test(body.deploymentId)||!idPattern.test(body.providerId))throw Error('exact runner application and provider required');
   await this.leaseReader.refresh([body.deploymentId]);
   const lease=this.leaseReader.get(body.deploymentId),c=lease?.connectivity,p=c?.providers?.find(p=>p.id===body.providerId);
   if(!p)throw Error('provider is not owner-authorized');
   terms={chainId:String(lease.chainId),connectivity:c.address.toLowerCase(),ledger:lease.deployments.toLowerCase(),deploymentId:lease.id,runnerId:lease.runner,providerId:p.id,nonce:String(c.nonce),leaseUntil:String(Math.floor(lease.leaseUntil/1000)),rate:String(p.pricePerGiB6),issuedAt:String(Math.floor(this.now()/1000))};
  }
  await this.leaseReader.refresh([terms.deploymentId]);const {lease}=this.context(terms);
  if(!uint.test(terms.issuedAt)||BigInt(terms.issuedAt)>BigInt(Math.floor(this.now()/1000))||BigInt(terms.issuedAt)+30n<BigInt(Math.floor(this.now()/1000)))throw Error('expired transport authorization');
  const hash=digest(terms,wire);
  if(server&&(await recoverMessageAddress({message:{raw:hash},signature:body.proof.signature})).toLowerCase()!==lease.runnerProofKey?.toLowerCase())throw Error('runner transport signature mismatch');
  // Never reuse a transport nonce, even after disconnect/restart. A new socket
  // must perform a new handshake; a signed transcript is not a bearer voucher.
  await this.store.update('seen-'+hash.slice(2),old=>{if(old)throw Error('transport authorization replay');return {issuedAt:terms.issuedAt};});
  proof={terms,signature:await this.proofAccount.signMessage({message:{raw:hash}})};
  const key=this.key(terms);await this.serial(key,()=>this.meter(terms));
  if(this.closed)throw Error('transport controller closed');
  const session=randomBytes(24).toString('hex');this.sessions.set(session,{id:session,terms,wire,hash,key,confirmed:false,createdAt:this.now(),lastSeen:this.now(),tickets:new Map(),queue:[],waiting:null,inflight:null});
  return {session,proof};
 }
 get(id,{confirmed=true}={}){
  const s=this.sessions.get(id);if(!s||this.closed||confirmed&&!s.confirmed)throw Error('unknown or unconfirmed transport session');
  this.context(s.terms);s.lastSeen=this.now();return s;
 }
 async confirm(id,proof){
  const s=this.get(id,{confirmed:false});if(s.confirmed)throw Error('transport already confirmed');
  if(this.now()>s.createdAt+30000)throw Error('transport handshake expired');
  if(this.role==='runner'){
   const {provider}=this.context(s.terms);
   if(serialize(proof?.terms)!==serialize(s.terms)||(await recoverMessageAddress({message:{raw:s.hash},signature:proof.signature})).toLowerCase()!==provider.proofKey.toLowerCase())throw Error('provider transport signature mismatch');
  }
  s.confirmed=true;return {};
 }
 async reserve(id,{direction,bytes}){
  const session=this.get(id);if(!['in','out'].includes(direction)||!Number.isInteger(bytes)||bytes<=0||bytes>32768||session.tickets.size>=256)throw Error('invalid transport reservation');
  return this.serial(session.key,async()=>{
   this.get(id);const {lease,c}=this.context(session.terms),s=await this.meter(session.terms),served=await this.chainBytes(lease,session.terms.providerId);
   const pending=this.reservations.get(session.key)||0n,total=this.total(s)+pending+BigInt(bytes);
   if(this.total(s)<served)throw Error('transport meter precedes settled traffic');
   const cost=ceil((total-served)*BigInt(session.terms.rate));
   if(cost>this.maxPending6||cost>BigInt(lease.balance6)||cost+BigInt(c.spent6)>BigInt(c.budget6))throw Error('USDC transport credit or budget exhausted');
   const ticket=randomBytes(16).toString('hex');session.tickets.set(ticket,{direction,bytes});this.reservations.set(session.key,pending+BigInt(bytes));return {ticket};
  });
 }
 async commit(id,{ticket,bytes}){
  const session=this.get(id);return this.serial(session.key,async()=>{
   const r=session.tickets.get(ticket);if(!r||!Number.isInteger(bytes)||bytes<0||bytes>r.bytes)throw Error('invalid transport commit');
   const state=await this.meter(session.terms);state[r.direction]=String(BigInt(state[r.direction])+BigInt(bytes));
   await this.store.set(session.key,state);session.tickets.delete(ticket);this.reservations.set(session.key,(this.reservations.get(session.key)||0n)-BigInt(r.bytes));return {};
  });
 }
 async observed(terms){const s=await this.serial(this.key(terms),()=>this.meter(terms));return this.total(s);}
 async remote(id,request){
  const s=this.get(id);if(this.role!=='provider')throw Error('provider control operation required');
  if(request?.type==='snapshot')return {bytes:String(await this.observed(s.terms))};
  if(request?.type!=='cosign'||request.envelope?.receipt?.id!==s.terms.deploymentId||request.envelope.receipt.providerId!==s.terms.providerId||String(request.envelope.receipt.policyNonce)!==s.terms.nonce)throw Error('misbound transport receipt');
  const signer=new TunaReceiptSigner({providerId:this.hostId,proofAccount:this.proofAccount,leaseReader:this.leaseReader,now:this.now,observedBytes:async q=>{if(q.runnerId!==s.terms.runnerId)throw Error('receipt runner changed');return this.observed(s.terms);}});
  return {signature:await signer.sign(request.envelope)};
 }
 request(s,request){
  if(!s.confirmed||!this.sessions.has(s.id)||s.queue.length>=8)throw Error('transport control unavailable');
  return new Promise((resolve,reject)=>{
   const item={id:randomBytes(16).toString('hex'),request,resolve,reject};
   item.timer=setTimeout(()=>{this.drop(s.id);reject(Error('transport control timed out'));},30000);s.queue.push(item);s.waiting?.();
  });
 }
 async next(id){
  const s=this.get(id);if(this.role!=='runner'||s.inflight||s.waiting)throw Error('one runner control stream required');
  if(!s.queue.length)await new Promise(resolve=>{const timer=setTimeout(()=>{s.waiting=null;resolve()},15000);s.waiting=()=>{clearTimeout(timer);s.waiting=null;resolve()};});
  this.get(id);
  if(!s.queue.length)s.queue.push({id:randomBytes(16).toString('hex'),request:{type:'snapshot'},resolve:()=>{},reject:()=>{}});
  s.inflight=s.queue.shift();return {id:s.inflight.id,request:s.inflight.request};
 }
 async reply(id,{id:requestId,response}){
  const s=this.get(id),pending=s.inflight;if(!pending||requestId!==pending.id)throw Error('transport reply mismatch');
  s.inflight=null;clearTimeout(pending.timer);pending.resolve(response);return {};
 }
 drop(id){
  const s=this.sessions.get(id);if(!s)return {};this.sessions.delete(id);s.waiting?.();
  void this.serial(s.key,()=>{for(const r of s.tickets.values())this.reservations.set(s.key,(this.reservations.get(s.key)||0n)-BigInt(r.bytes));s.tickets.clear();});
  for(const item of [...s.queue,...(s.inflight?[s.inflight]:[])]){clearTimeout(item.timer);item.reject(Error('transport disconnected'));}
  return {};
 }
 async tick(){
  const ids=[...new Set([...this.sessions.values()].map(s=>s.terms.deploymentId))];for(let i=0;i<ids.length;i+=256)await this.leaseReader.refresh(ids.slice(i,i+256));
  if(this.now()-this.lastPruned>=60000){
   this.lastPruned=this.now();
   for(const name of await fs.readdir(this.store.directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
    if(!/^seen-[a-f0-9]{64}\.json$/.test(name))continue;
    const seen=await this.store.get(name.slice(0,-5));
    // A transcript older than 30 seconds cannot pass openSession. Keep twice
    // that window, then remove only its replay marker, never traffic counters.
    if(seen&&uint.test(seen.issuedAt)&&BigInt(seen.issuedAt)+60n<BigInt(Math.floor(this.now()/1000)))await fs.unlink(path.join(this.store.directory,name));
   }
  }
  for(const s of [...this.sessions.values()]){try{this.context(s.terms);if(!s.confirmed&&this.now()>s.createdAt+30000||this.now()>s.lastSeen+60000)throw Error('transport inactive');}catch{this.drop(s.id)}}
  if(this.role!=='runner')return;
  const seen=new Set();
  for(const s of this.sessions.values()){
   if(!s.confirmed||seen.has(s.key))continue;seen.add(s.key);
   const snapshot=await this.request(s,{type:'snapshot'});if(!uint.test(snapshot?.bytes||''))throw Error('invalid provider meter');
   const local=await this.observed(s.terms),bytes=local<BigInt(snapshot.bytes)?local:BigInt(snapshot.bytes);
   if(bytes===0n)continue;
   let settlement=this.settlements.get(s.terms.providerId);
   if(!settlement){
    const cosign=envelope=>{const live=[...this.sessions.values()].find(x=>x.confirmed&&x.terms.deploymentId===envelope.receipt.id&&x.terms.providerId===envelope.receipt.providerId&&x.terms.nonce===String(envelope.receipt.policyNonce));if(!live)throw Error('provider receipt connection unavailable');return this.request(live,{type:'cosign',envelope}).then(r=>r.signature);};
    settlement=await this.settlementFactory(s.terms.providerId,cosign);this.settlements.set(s.terms.providerId,settlement);
   }
   const cost=ceil(bytes*BigInt(s.terms.rate));
   await settlement.authorizeDebit({deploymentId:s.terms.deploymentId,policyHash:s.key,cumulativeBytes:String(bytes),cumulativeCost6:String(cost),pricePerGiB6:s.terms.rate,nonce:s.terms.nonce});
   await settlement.flush();
  }
 }
 async close(){this.closed=true;for(const id of [...this.sessions.keys()])this.drop(id);await Promise.allSettled([...this.queues.values()]);for(const s of this.settlements.values())await s.close();}
}
