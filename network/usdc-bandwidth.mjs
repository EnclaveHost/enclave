// Direct-bandwidth receipt producer. It uses the registry's compute proof key;
// the key's trust level is the same as that host's compute signer. A Windows
// host-controlled key is not represented as hardware-isolated metering.
import {createPublicClient,createWalletClient,http,parseAbi,encodeAbiParameters,keccak256} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DurableState} from './durable-state.mjs';

const receiptType={type:'tuple',components:[['id','bytes32'],['hostId','bytes32'],['policyNonce','uint64'],['leaseUntil','uint64'],['issuedAt','uint64'],['anchor','uint64'],['cumulativeBytes','uint128'],['pricePerGiB6','uint64']].map(([name,type])=>({name,type}))};
export const bandwidthABI=[...parseAbi(['function bytesServed(bytes32) view returns (uint128)']),
 {type:'function',name:'settle',stateMutability:'nonpayable',inputs:[{name:'r',...receiptType},{name:'signature',type:'bytes'}],outputs:[]}];
const walletQueues=new Map();
const Gib=1n<<30n,ceil=n=>(n+Gib-1n)/Gib;
export function receiptDigest({chainId,connectivity,ledger,receipt,anchorHash}) {
 return keccak256(encodeAbiParameters([{type:'string'},{type:'uint256'},{type:'address'},{type:'address'},receiptType,{type:'bytes32'}],
 ['EnclaveConnectivity.receipt.v1',BigInt(chainId),connectivity,ledger,receipt,anchorHash]));
}
export function meterKey(id,hostId,nonce){return keccak256(encodeAbiParameters([{type:'bytes32'},{type:'bytes32'},{type:'uint64'}],[id,hostId,BigInt(nonce)]));}
// Provider credit is explicit and bounded. Zero waits for settlement before
// admitting each charge; a positive cap batches settlement off the packet path.
// Outstanding credit can be lost on owner revocation/lease loss, just as unpaid
// native TUNA traffic can be lost. It is never a second customer balance.
export class USDCBandwidthSettlement {
 constructor({directory,transactionDirectory,leaseReader,proofAccount,wallet,client,maxPending6,intervalMs=10000,now=Date.now,log=()=>{}}){
  if(!/^(0|[1-9]\d{0,11})$/.test(maxPending6||'')||intervalMs<1000||intervalMs>20000)throw Error('explicit bounded provider credit required');
  Object.assign(this,{leaseReader,proofAccount,wallet,client,maxPending6:BigInt(maxPending6),intervalMs,now,log});
  this.state=new DurableState(path.join(directory,'accepted'));this.transactions=new DurableState(transactionDirectory||path.join(directory,'transactions'));this.queueKey=path.resolve(this.transactions.directory);this.apps=new Map();this.confirmed=new Map();this.tail=Promise.resolve();
 }
 context(id,nonce,price){
  const lease=this.leaseReader.get(id),c=lease?.connectivity;
  if(!lease?.active||!c?.direct||c.viaTuna||String(c.nonce)!==String(nonce)||Number(c.expires)*1000<=this.now()||
   c.owner.toLowerCase()!==lease.owner.toLowerCase()||lease.runnerProofKey?.toLowerCase()!==this.proofAccount.address.toLowerCase())throw Error('current bound meter authorization required');
  if(String(c.pricePerGiB6)!==String(price)||BigInt(c.budget6)<BigInt(c.spent6)||BigInt(lease.bandwidthBackingRequired6||'-1')!==0n)throw Error('bandwidth rate or USDC backing changed');
  return {lease,c};
 }
 meterHost(lease){return lease.runner;}
 async chainBytes(lease,c){
  const cacheKey=lease.id+':'+this.meterHost(lease)+':'+c.nonce+':'+lease.blockHash;
  if(this.confirmed.has(cacheKey))return this.confirmed.get(cacheKey);
  const args={address:c.address,abi:bandwidthABI,functionName:'bytesServed',args:[meterKey(lease.id,this.meterHost(lease),c.nonce)],blockNumber:BigInt(lease.blockNumber)};
  const values=await Promise.all(this.leaseReader.clients.map(client=>client.readContract(args).then(String).catch(()=>null)));
  for(const value of values)if(value!==null&&values.filter(v=>v===value).length>=2){if(this.confirmed.size>1024)this.confirmed.clear();this.confirmed.set(cacheKey,BigInt(value));return BigInt(value);}
  throw Error('bandwidth payment quorum unavailable');
 }
 async authorizeDebit({deploymentId,policyHash,cumulativeBytes,cumulativeCost6,pricePerGiB6,nonce,counters}){
  const key=deploymentId.slice(2)+'-'+nonce;this.apps.set(key,{deploymentId,nonce,pricePerGiB6});
  await this.state.update(key,async old=>{
   let {lease,c}=this.context(deploymentId,nonce,pricePerGiB6);
   if(old&&(old.policyHash!==policyHash||old.rate!==pricePerGiB6||old.hostId!==this.meterHost(lease)||(old.runnerId&&old.runnerId!==lease.runner)))throw Error('meter identity changed; a new owner authorization is required');
   const bytes=BigInt(cumulativeBytes),cost=BigInt(cumulativeCost6),rate=BigInt(pricePerGiB6);
   if(bytes<BigInt(old?.bytes||'0')||cost!==ceil(bytes*rate))throw Error('meter amount differs from byte counter');
   let served=await this.chainBytes(lease,c);
   if(bytes<served)throw Error('local meter precedes confirmed traffic');
   const pending=ceil((bytes-served)*rate);
   if(BigInt(c.spent6)+pending>BigInt(c.budget6)||pending>BigInt(lease.balance6))throw Error('available app USDC or owner bandwidth budget exhausted');
   if(counters&&(!['in','out','cost6','units'].every(k=>/^(0|[1-9]\d*)$/.test(counters[k]))||BigInt(counters.in)+BigInt(counters.out)!==bytes||BigInt(counters.units)!==bytes*rate||BigInt(counters.cost6)!==cost))throw Error('invalid durable meter counters');
   const next={...(counters?{counters}:{}),policyHash,hostId:this.meterHost(lease),runnerId:lease.runner,rate:pricePerGiB6,nonce:String(nonce),bytes:(bytes>BigInt(old?.bytes||'0')?bytes:BigInt(old?.bytes||'0')).toString()};
   if(pending>this.maxPending6){await this.settle(deploymentId,next);}
   return next;
  });
 }
 async recoverCounters({deploymentId,policyHash,nonce,pricePerGiB6}){
  const saved=await this.state.get(deploymentId.slice(2)+'-'+nonce);
  const journal=await this.transactions.get('wallet-current');
  const candidates=[saved];
  if((!journal?.acceptedDirectory||path.resolve(journal.acceptedDirectory)===path.resolve(this.state.directory))&&(journal?.meter||'direct')===this.meterNamespace()&&journal?.deploymentId===deploymentId&&String(journal.nonce)===String(nonce)&&['prepared','confirmed'].includes(journal.state))candidates.push(journal.accepted);
  let result;
  for(const s of candidates){
   if(!s)continue;
   if(s.policyHash!==policyHash||s.rate!==pricePerGiB6)throw Error('durable meter identity changed');
   if(!s.counters)throw Error('durable meter counters missing; reconciliation required');
   const c=s.counters;
   if(!['in','out','cost6','units'].every(k=>/^(0|[1-9]\d*)$/.test(c[k]))||BigInt(c.in)+BigInt(c.out)!==BigInt(s.bytes)||BigInt(c.units)!==BigInt(s.bytes)*BigInt(s.rate)||BigInt(c.cost6)!==ceil(BigInt(c.units)))throw Error('damaged durable meter counters');
   if(!result||BigInt(c.units)>BigInt(result.units))result=c;
  }
  return result;
 }
 meterNamespace(){return 'direct';}
 settle(id,s){
  const operation=(walletQueues.get(this.queueKey)||Promise.resolve()).then(()=>this.sendReceipt(id,s));
  const tail=operation.catch(()=>{});walletQueues.set(this.queueKey,tail);
  void tail.then(()=>{if(walletQueues.get(this.queueKey)===tail)walletQueues.delete(this.queueKey);});return operation;
 }
 async signedReceipt({id,s,lease,c,head}){
  const receipt={id,hostId:lease.runner,policyNonce:BigInt(s.nonce),leaseUntil:BigInt(Math.floor(lease.leaseUntil/1000)),
   issuedAt:BigInt(Math.floor(this.now()/1000)),anchor:BigInt(lease.blockNumber),cumulativeBytes:BigInt(s.bytes),pricePerGiB6:BigInt(s.rate)};
  const digest=receiptDigest({chainId:lease.chainId,connectivity:c.address,ledger:lease.deployments,receipt,anchorHash:head.hash});
  const signature=await this.proofAccount.signMessage({message:{raw:digest}});
  return {receipt,abi:bandwidthABI,functionName:'settle',args:[receipt,signature]};
 }
 async sendReceipt(id,s){
  const key='wallet-current';
  // One global nonce journal covers every app using this gas wallet.
  // Reconcile an interrupted signed transaction before preparing another nonce.
  const prior=await this.transactions.get(key);
  if(prior?.state==='prepared'){
   const done=await this.client.getTransactionReceipt({hash:prior.hash}).catch(()=>null);
   if(done){await this.transactions.set(key,{...prior,state:done.status==='success'?'confirmed':'reverted'});if(done.status!=='success')throw Error('bandwidth settlement reverted');await this.leaseReader.refresh([...new Set([id,prior.deploymentId])]);}
   else {await this.client.sendRawTransaction({serializedTransaction:prior.raw}).catch(()=>{});throw Error('bandwidth transaction remains pending');}
  }
  if(prior?.acceptedDirectory&&['prepared','confirmed'].includes(prior.state)&&(path.resolve(prior.acceptedDirectory)!==path.resolve(this.state.directory)||prior.meter!==this.meterNamespace()||prior.deploymentId!==id||String(prior.nonce)!==String(s.nonce))){
   const saved=await new DurableState(prior.acceptedDirectory).get(prior.deploymentId.slice(2)+'-'+prior.nonce);
   if(!saved||BigInt(saved.bytes)<BigInt(prior.accepted.bytes))throw Error('previous meter must recover its accepted counters before sharing this gas wallet');
  }
  await this.leaseReader.refresh([id]);
  const {lease,c}=this.context(id,s.nonce,s.rate);const served=await this.chainBytes(lease,c);
  if(BigInt(s.bytes)<=served)return;
  const head=await this.client.getBlock({blockNumber:BigInt(lease.blockNumber)});
  if(head.hash!==lease.blockHash)throw Error('bandwidth receipt anchor changed');
  const {receipt,abi,functionName,args}=await this.signedReceipt({id,s,lease,c,head});
  const {encodeFunctionData}=await import('viem');
  const request=await this.wallet.prepareTransactionRequest({account:this.wallet.account,chain:this.wallet.chain,
   to:c.address,data:encodeFunctionData({abi,functionName,args})});
  const raw=await this.wallet.signTransaction(request),hash=keccak256(raw);
  await this.transactions.set(key,{acceptedDirectory:this.state.directory,meter:this.meterNamespace(),state:'prepared',deploymentId:id,nonce:s.nonce,accepted:s,hash,raw,bytes:s.bytes,issuedAt:String(receipt.issuedAt)});
  await this.client.sendRawTransaction({serializedTransaction:raw});
  const confirmed=await this.client.waitForTransactionReceipt({hash,timeout:20000,confirmations:2});
  await this.transactions.set(key,{acceptedDirectory:this.state.directory,meter:this.meterNamespace(),state:confirmed.status==='success'?'confirmed':'reverted',deploymentId:id,nonce:s.nonce,accepted:s,hash,raw,bytes:s.bytes});
  if(confirmed.status!=='success')throw Error('bandwidth settlement reverted');
  await this.leaseReader.refresh([id]);
 }
 async flush(){for(const [key,{deploymentId}] of this.apps){await this.state.update(key,async s=>{if(s)await this.settle(deploymentId,s);return s;}).catch(e=>this.log('USDC bandwidth: '+e.message));}}
 async start(){
  for(const name of await fs.readdir(this.state.directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
   const m=/^([0-9a-f]{64})-([1-9][0-9]*)\.json$/.exec(name);if(!m)continue;
   const key=name.slice(0,-5),s=await this.state.get(key);if(s)this.apps.set(key,{deploymentId:'0x'+m[1],nonce:m[2],pricePerGiB6:s.rate});
  }
  const pending=await this.transactions.get('wallet-current');
  if(pending&&(!pending.acceptedDirectory||path.resolve(pending.acceptedDirectory)===path.resolve(this.state.directory))&&(pending.meter||'direct')===this.meterNamespace()&&['prepared','confirmed'].includes(pending.state)){const k=pending.deploymentId.slice(2)+'-'+pending.nonce;this.apps.set(k,{deploymentId:pending.deploymentId,nonce:pending.nonce,pricePerGiB6:pending.accepted.rate});
    await this.state.update(k,old=>!old||BigInt(old.bytes)<BigInt(pending.accepted.bytes)?pending.accepted:old);}
  this.timer=setInterval(()=>void this.flush(),this.intervalMs);this.timer.unref();return this;}
 async close(){clearInterval(this.timer);await this.flush();}
}
export async function createUSDCBandwidthSettlement({config,directory,leaseReader,log}){
 const [proof,gas]=await Promise.all([fs.readFile(config.proofKeyFile,'utf8'),fs.readFile(config.gasKeyFile,'utf8')]);
 const {base}=await import('viem/chains');
 if(leaseReader.chainId!==base.id)throw Error('configured production settlement chain must be Base');
 const account=privateKeyToAccount(gas.trim()),proofAccount=privateKeyToAccount(proof.trim());
 if(!config.rpc?.startsWith('https://'))throw Error('HTTPS settlement RPC required');
 const client=createPublicClient({chain:base,transport:http(config.rpc,{timeout:15000})});
 const wallet=createWalletClient({account,chain:base,transport:http(config.rpc,{timeout:15000})});
 return new USDCBandwidthSettlement({directory,transactionDirectory:config.transactionDirectory,leaseReader,proofAccount,wallet,client,maxPending6:config.maxPending6,log}).start();
}
