// Paid Enclave-network providers (docs/design/enclave-network.md, "Paid providers"). A community provider is a
// registry host; it charges its on-chain price through the existing EnclaveConnectivity contract:
//   - the app's owner authorizes it on chain (authorizeTuna: these exact providers, an aggregate price cap, a budget
//     and an expiry, signed by the owner), and this provider admits an app's peers only while that authorization
//     names it at its current price and the budget is not spent (paidGate);
//   - it meters each paid peer itself, from the kernel's per-peer WireGuard counters, durably and per on-chain policy
//     nonce (PeerMeter);
//   - it co-signs the host's cumulative receipt only up to what it observed (TunaReceiptSigner, unchanged), and the
//     host submits settleTuna, which charges the app's existing USDC balance (ledger.chargeBandwidth).
// A free provider (price 0) uses none of this.
import fs from 'node:fs/promises';
import {tunaContext,TunaReceiptSigner} from '../tuna-usdc-settlement.mjs';

// -> the on-chain policy nonce the peer is admitted under; throws unless the owner's current authorization names this
// provider (hostId) at exactly its price, within the aggregate cap, with budget left.
export function paidGate({lease,hostId,pricePerGiB6,now=Date.now()}){
 if(!/^0x[0-9a-f]{64}$/.test(hostId||''))throw new Error('a paid provider must be a registry host');
 const nonce=String(lease?.connectivity?.nonce??'');
 const {c}=tunaContext(lease,hostId,nonce,String(pricePerGiB6),now);
 if(BigInt(c.spent6)>=BigInt(c.budget6))throw new Error('the owner\'s bandwidth budget for this app is spent');
 return nonce;
}

export const meterKey=({deploymentId,runnerId,nonce})=>`${deploymentId}|${runnerId}|${nonce}`;

// Durable per-(app, runner, policy nonce) byte totals. The kernel's per-peer counters restart whenever a peer is
// re-added or the interface is rebuilt, so each sample adds only the growth since the last one it saw for that key
// (a smaller value means the counter restarted: all of it is new). Both directions count, as on the host.
export class PeerMeter {
 constructor({file,kernel,log=()=>{}}){Object.assign(this,{file,kernel,log});this.state={totals:{},last:{}};this.saving=Promise.resolve();}
 async load(){try{const s=JSON.parse(await fs.readFile(this.file,'utf8'));if(s&&typeof s.totals==='object'&&typeof s.last==='object')this.state=s;}catch{}return this;}
 save(){const tmp=`${this.file}.${process.pid}.tmp`;return this.saving=this.saving.catch(()=>{}).then(async()=>{await fs.writeFile(tmp,JSON.stringify(this.state),{mode:0o600});await fs.rename(tmp,this.file);});}
 // peers: the provider's peer table entries that carry a paid nonce
 async sample(peers){
  const paid=peers.filter(p=>p.paidNonce);if(!paid.length)return;
  const stats=await this.kernel.stats();let changed=false;
  for(const p of paid){
   const s=stats[p.key];if(!s)continue;
   const cur=BigInt(s.rx)+BigInt(s.tx),last=BigInt(this.state.last[p.key]??'0');
   const delta=cur>=last?cur-last:cur;
   if(delta>0n){const k=meterKey({deploymentId:p.deploymentId,runnerId:p.runner,nonce:p.paidNonce});this.state.totals[k]=(BigInt(this.state.totals[k]??'0')+delta).toString();changed=true;}
   if(String(cur)!==this.state.last[p.key]){this.state.last[p.key]=String(cur);changed=true;}
  }
  if(changed)await this.save();
 }
 // a removed peer's last counter reading is no longer needed (its totals stay)
 async forget(key){if(key in this.state.last){delete this.state.last[key];await this.save();}}
 observed(k){return BigInt(this.state.totals[meterKey(k)]??'0');}
}

// Receipt JSON on the wire: integers as decimal strings; bytes32 fields as hex.
const UINTS=['policyNonce','leaseUntil','issuedAt','anchor','cumulativeBytes','pricePerGiB6'];
export const receiptToJSON=r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==='bigint'?v.toString():v]));
export function receiptFromJSON(r){
 const keys=['id','runnerId','providerId',...UINTS];
 if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!==[...keys].sort().join(','))throw new Error('invalid receipt');
 for(const k of ['id','runnerId','providerId'])if(!/^0x[0-9a-f]{64}$/.test(r[k]))throw new Error('invalid receipt');
 for(const k of UINTS)if(typeof r[k]!=='string'||!/^(0|[1-9]\d{0,38})$/.test(r[k]))throw new Error('invalid receipt');
 return {id:r.id,runnerId:r.runnerId,providerId:r.providerId,...Object.fromEntries(UINTS.map(k=>[k,BigInt(r[k])]))};
}

// The co-signing side of the control API: POST /v1/receipt {receipt, runnerSignature, anchorHash} -> {signature}.
export function createReceiptCosigner({hostId,proofAccount,leaseReader,meter,sample,now=Date.now}){
 const signer=new TunaReceiptSigner({providerId:hostId,proofAccount,leaseReader,now,
  observedBytes:async k=>{await sample();return meter.observed(k);}});
 return async body=>{
  if(!body||typeof body.runnerSignature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(body.runnerSignature)||!/^0x[0-9a-f]{64}$/.test(body.anchorHash||''))throw new Error('receipt, runner signature and anchor hash required');
  return {signature:await signer.sign({receipt:receiptFromJSON(body.receipt),runnerSignature:body.runnerSignature,anchorHash:body.anchorHash})};
 };
}
