// USDC TUNA settlement is separate from NanoPay. A transport must meter both
// endpoints and negotiate this mode before using these receipts; configuring
// this class alone does not turn a native-NKN provider into a USDC provider.
import {encodeAbiParameters,keccak256,recoverMessageAddress,parseAbi} from 'viem';
import {USDCBandwidthSettlement} from './usdc-bandwidth.mjs';
const receiptType={type:'tuple',components:[['id','bytes32'],['runnerId','bytes32'],['providerId','bytes32'],['policyNonce','uint64'],['leaseUntil','uint64'],['issuedAt','uint64'],['anchor','uint64'],['cumulativeBytes','uint128'],['pricePerGiB6','uint64']].map(([name,type])=>({name,type}))};
export const tunaBandwidthABI=[...parseAbi(['function bytesServed(bytes32) view returns (uint128)']),
 {type:'function',name:'settleTuna',stateMutability:'nonpayable',inputs:[{name:'r',...receiptType},{name:'runnerSignature',type:'bytes'},{name:'providerSignature',type:'bytes'}],outputs:[]}];
export function tunaReceiptDigest({chainId,connectivity,ledger,receipt,anchorHash}){
 return keccak256(encodeAbiParameters([{type:'string'},{type:'uint256'},{type:'address'},{type:'address'},receiptType,{type:'bytes32'}],
 ['EnclaveConnectivity.tuna-receipt.v1',BigInt(chainId),connectivity,ledger,receipt,anchorHash]));
}
export function tunaContext(lease,providerId,nonce,rate,now=Date.now()){
 const c=lease?.connectivity;
 if(!lease?.active||lease.validUntil<=now||lease.leaseUntil<=now||!c?.viaTuna||String(c.nonce)!==String(nonce)||Number(c.expires)*1000<=now||c.owner.toLowerCase()!==lease.owner.toLowerCase())throw Error('current USDC TUNA authorization required');
 const providers=c.providers;
 if(!Array.isArray(providers)||providers.length<1||providers.length>6||new Set(providers.map(p=>p.id)).size!==providers.length)throw Error('invalid TUNA provider path');
 let total=0n;
 for(const p of providers){
  total+=BigInt(p.pricePerGiB6);
 }
 const provider=providers.find(p=>p.id===providerId);
 if(!provider?.qualified||!provider.active||Number(provider.qualifiedUntil)*1000<=now||!/^0x[0-9a-f]{40}$/i.test(provider.proofKey)||/^0x0{40}$/i.test(provider.proofKey))throw Error('current TUNA provider qualification required');
 if(!provider||total>BigInt(c.maxPricePerGiB6)||String(provider.pricePerGiB6)!==String(rate)||BigInt(rate)<=0n)throw Error('TUNA provider or aggregate price changed');
 if(BigInt(c.budget6)<BigInt(c.spent6)||BigInt(lease.bandwidthBackingRequired6??'-1')!==0n)throw Error('backed USDC bandwidth budget required');
 return {lease,c,provider};
}
export class TunaUSDCSettlement extends USDCBandwidthSettlement {
 constructor({providerId,cosign,...options}){
  super(options);
  if(!/^0x[0-9a-f]{64}$/.test(providerId||'')||typeof cosign!=='function')throw Error('bound provider and receipt co-signer required');
  this.providerId=providerId;this.cosign=cosign;
 }
 meterNamespace(){return this.providerId;}
 meterHost(){return this.providerId;}
 context(id,nonce,rate){
  const context=tunaContext(this.leaseReader.get(id),this.providerId,nonce,rate,this.now());
  if(context.lease.runnerProofKey?.toLowerCase()!==this.proofAccount.address.toLowerCase())throw Error('current runner proof key required');
  return context;
 }
 async signedReceipt({id,s,lease,c,head}){
  const {provider}=this.context(id,s.nonce,s.rate);
  const receipt={id,runnerId:lease.runner,providerId:this.providerId,policyNonce:BigInt(s.nonce),leaseUntil:BigInt(Math.floor(lease.leaseUntil/1000)),
   issuedAt:BigInt(Math.floor(this.now()/1000)),anchor:BigInt(lease.blockNumber),cumulativeBytes:BigInt(s.bytes),pricePerGiB6:BigInt(s.rate)};
  const digest=tunaReceiptDigest({chainId:lease.chainId,connectivity:c.address,ledger:lease.deployments,receipt,anchorHash:head.hash});
  const runnerSignature=await this.proofAccount.signMessage({message:{raw:digest}});
  const providerSignature=await this.cosign({receipt,runnerSignature,anchorHash:head.hash});
  if((await recoverMessageAddress({message:{raw:digest},signature:providerSignature})).toLowerCase()!==provider.proofKey.toLowerCase())throw Error('provider receipt signature mismatch');
  return {receipt,abi:tunaBandwidthABI,functionName:'settleTuna',args:[receipt,runnerSignature,providerSignature]};
 }
}
// Provider-side co-signer. observedBytes must read its own durable transport
// meter for this app, runner and policy; it must never read the peer's claim.
// No customer balance or signature is trusted from the request.
export class TunaReceiptSigner {
 constructor({providerId,proofAccount,leaseReader,observedBytes,now=Date.now}){
  if(!/^0x[0-9a-f]{64}$/.test(providerId||'')||typeof observedBytes!=='function')throw Error('provider transport meter required');
  Object.assign(this,{providerId,proofAccount,leaseReader,observedBytes,now});
 }
 async sign({receipt:r,runnerSignature,anchorHash}){
  await this.leaseReader.refresh([r.id]);
  const {lease,c,provider}=tunaContext(this.leaseReader.get(r.id),this.providerId,r.policyNonce,r.pricePerGiB6,this.now());
  if(r.providerId!==this.providerId||r.runnerId!==lease.runner||BigInt(r.leaseUntil)!==BigInt(Math.floor(lease.leaseUntil/1000))||provider.proofKey.toLowerCase()!==this.proofAccount.address.toLowerCase()||
    BigInt(r.issuedAt)>BigInt(Math.floor(this.now()/1000))||BigInt(r.issuedAt)<BigInt(Math.floor(this.now()/1000)-30)||BigInt(r.anchor)>BigInt(lease.blockNumber)||BigInt(lease.blockNumber)-BigInt(r.anchor)>128n)throw Error('stale or misbound TUNA receipt');
  // Quorum on the receipt's exact anchor, even when this provider has a newer lease snapshot.
  const hashes=await Promise.all(this.leaseReader.clients.map(client=>client.getBlock({blockNumber:BigInt(r.anchor)}).then(b=>b.hash).catch(()=>null)));
  if(hashes.filter(h=>h===anchorHash).length<2)throw Error('receipt anchor quorum unavailable');
  const digest=tunaReceiptDigest({chainId:lease.chainId,connectivity:c.address,ledger:lease.deployments,receipt:r,anchorHash});
  if((await recoverMessageAddress({message:{raw:digest},signature:runnerSignature})).toLowerCase()!==lease.runnerProofKey?.toLowerCase())throw Error('runner receipt signature mismatch');
  const observed=await this.observedBytes({deploymentId:r.id,runnerId:r.runnerId,providerId:this.providerId,nonce:String(r.policyNonce)});
  if(typeof observed!=='bigint'||BigInt(r.cumulativeBytes)<=0n||BigInt(r.cumulativeBytes)>observed)throw Error('receipt exceeds provider-observed traffic');
  return this.proofAccount.signMessage({message:{raw:digest}});
 }
}
