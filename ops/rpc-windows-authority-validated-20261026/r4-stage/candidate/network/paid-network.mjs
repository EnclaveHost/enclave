// Paid Enclave-network providers, the host's side (docs/design/enclave-network.md, "Paid providers"; the provider's
// side is wg-provider/paid.mjs). A provider with a price is a community provider: a registry host whose price, and the
// app owner's authorization of it, live in the existing EnclaveConnectivity contract (authorizeTuna: these exact
// providers, an aggregate price cap, a budget, an expiry; signed by the owner). Here:
//   - paidEligible: a priced provider is usable for an app only while that on-chain authorization names it at exactly
//     its price and the budget is not spent; free providers always are;
//   - PaidNetwork.meter: the app bytes through each paid hop, accumulated durably per (app, provider, on-chain policy
//     nonce), are authorized with the existing settlement (ProviderUSDCSettlement.authorizeDebit), which settles receipts
//     co-signed by the provider (settleTuna charges the app's USDC balance); a circuit whose debit is refused (budget
//     spent, authorization revoked or changed) is reported so the manager closes it - no unpaid traffic continues.
import path from 'node:path';
import fs from 'node:fs/promises';
import {keccak256,encodeAbiParameters,createPublicClient,createWalletClient,http,fallback} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {providerContext,ProviderUSDCSettlement} from './provider-settlement.mjs';
import {receiptToJSON} from './wg-provider/paid.mjs';
import {DurableState} from './durable-state.mjs';

const GIB=1n<<30n,ceil=n=>(n+GIB-1n)/GIB;

export function paidEligible(lease,p,now=Date.now()){
 if(!(p.pricePerGiB6>0))return true;
 if(p.kind!=='community'||!/^0x[0-9a-f]{64}$/.test(p.hostId||''))return false;
 try{
  const {c}=providerContext(lease,p.hostId,String(lease?.connectivity?.nonce??''),String(p.pricePerGiB6),now);
  return BigInt(c.spent6)<BigInt(c.budget6);
 }catch{return false;}
}

const stateKey=(id,hostId,nonce)=>keccak256(encodeAbiParameters([{type:'bytes32'},{type:'bytes32'},{type:'uint64'}],[id,hostId,BigInt(nonce)])).slice(2);

export class PaidNetwork {
 // settlementFor(hostId) -> the provider's settlement ({authorizeDebit}); leaseReader reads connectivity ('auto')
 constructor({directory,leaseReader,settlementFor,now=Date.now,log=()=>{}}){
  Object.assign(this,{leaseReader,settlementFor,now,log});
  this.totals=new DurableState(path.join(directory,'paid-meter'));this.seen=new Map();
 }
 eligible(app,p){return paidEligible(this.leaseReader.get(app.id),p,this.now());}
 // -> [{app, circuit, reason}] for circuits that must close
 async meter(apps){
  const refused=[];
  for(const app of apps){
   const lease=this.leaseReader.get(app.id),nonce=lease?.connectivity?.nonce;
   for(const c of app.circuits){
    if(c.kind!=='network'||c.closed)continue;
    const hops=[c.providers?.guard,c.providers?.exit].filter(p=>p&&p.pricePerGiB6>0);
    if(!hops.length)continue;
    // growth of this circuit's app bytes since the last pass (a circuit's counters only grow; a new circuit starts at 0)
    const up=BigInt(c.stats?.app?.up||0),down=BigInt(c.stats?.app?.down||0),prev=this.seen.get(c.id)||{up:0n,down:0n};
    const dUp=up>=prev.up?up-prev.up:up,dDown=down>=prev.down?down-prev.down:down;
    this.seen.set(c.id,{up,down});
    for(const p of hops){
     try{
      if(nonce===undefined||!paidEligible(lease,p,this.now()))throw new Error('no current on-chain authorization for this paid provider');
      const rate=BigInt(p.pricePerGiB6);
      const t=await this.totals.update(stateKey(app.id,p.hostId,nonce),old=>{
       if(old&&(old.rate!==String(rate)||old.hostId!==p.hostId))throw new Error('paid meter identity changed');
       const inB=BigInt(old?.in||'0')+dDown,outB=BigInt(old?.out||'0')+dUp,units=(inB+outB)*rate;
       return {hostId:p.hostId,nonce:String(nonce),rate:String(rate),in:String(inB),out:String(outB),units:String(units),cost6:String(ceil(units))};
      });
      const bytes=BigInt(t.in)+BigInt(t.out);if(!bytes)continue;
      await (await this.settlementFor(p.hostId)).authorizeDebit({deploymentId:app.id,policyHash:`${lease.connectivity.address}:${nonce}:${p.hostId}`,
       cumulativeBytes:String(bytes),cumulativeCost6:t.cost6,pricePerGiB6:t.rate,nonce:String(nonce),counters:{in:t.in,out:t.out,cost6:t.cost6,units:t.units}});
     }catch(e){refused.push({app,circuit:c,reason:'paid provider: '+e.message});break;}
    }
   }
  }
  for(const id of [...this.seen.keys()])if(!apps.some(a=>a.circuits.some(c=>c.id===id)))this.seen.delete(id);
  return refused;
 }
}

// The host's paid-provider settlement, configured by enclaveNetwork.paid {proofKeyFile (the registry proof key that signs
// this host's receipts), gasKeyFile (pays settlement gas), rpc (https), maxPending6 (unsettled provider credit allowed,
// in USDC micro-units)}: one settlement per paid provider, sharing one gas-wallet journal; the provider's co-signature
// is requested from its control API through fetchFn (the host's control circuits).
// The settlement chain (client + wallet) for paid-provider settlement. Under the agent's explicit LOCAL VERIFIER authority
// (leaseReader.authority 'verifier', network/chain-authority.mjs exactly as supervisor.js uses it): every read - the nonce
// ('latest' account proof), the anchor block, receipts (checked against the receipts root) - goes to the verifier; the
// submission and the pending/fee hints go to the operator's OWN transaction backend only, and each submission is preceded
// by the authority's actionGate (fresh verifier head, backend bound to the verifier's chain). A settlement is confirmed
// ONLY by a receipt the verifier returns (USDCBandwidthSettlement waits for it, 2 confirmations, status success); the
// backend accepting a transaction is never success. No settlement RPC and no public default is used in that mode, and a
// settlement RPC or a missing backend there is refused. Legacy (quorum authority): the configured HTTPS RPC + the two
// public defaults, unchanged; a txBackend there is refused (never mixed).
export async function settlementChain({config,leaseReader,chainVerifier}){
 const {base}=await import('viem/chains');
 if(leaseReader?.authority==='verifier'){
  if(config.rpc!==undefined)throw new Error('paid settlement under the local verifier takes no settlement RPC (it would be a provider beside the verifier)');
  if(!config.txBackend)throw new Error("paid settlement under the local verifier needs the operator's own transaction backend (enclaveNetwork.paid.txBackend)");
  if(!chainVerifier)throw new Error("paid settlement under the local verifier needs the agent's verifier (cfg.chain.verifier)");
  const {createChainAuthority}=await import('./chain-authority.mjs');
  const authority=createChainAuthority({verifier:chainVerifier,backend:config.txBackend,chain:base});
  const client=createPublicClient({chain:base,transport:authority.transport});
  const submit=client.sendRawTransaction.bind(client);
  client.sendRawTransaction=async args=>{await authority.actionGate({what:'paid bandwidth settlement',submit:true});return submit(args);};
  return {client,wallet:account=>createWalletClient({account,chain:base,transport:authority.transport}),authority};
 }
 if(config.txBackend!==undefined)throw new Error('a settlement txBackend is set but the agent is not under the local verifier authority');
 if(!String(config.rpc||'').startsWith('https://'))throw new Error('an HTTPS settlement RPC is required');
 // receipts and nonces must be readable: some public RPCs refuse receipt lookups, so others follow the configured one
 const transport=fallback([...new Set([config.rpc,'https://base.drpc.org','https://mainnet.base.org'])].map(u=>http(u,{timeout:15000})));
 return {client:createPublicClient({chain:base,transport}),wallet:account=>createWalletClient({account,chain:base,transport}),authority:null};
}
export async function createPaidNetwork({config,directory,leaseReader,providers,fetchFn,chainVerifier,log=()=>{}}){
 if(!config?.proofKeyFile||!config.gasKeyFile||!/^(0|[1-9]\d{0,11})$/.test(config.maxPending6||''))throw new Error('enclaveNetwork.paid needs proofKeyFile, gasKeyFile and maxPending6');
 const {base}=await import('viem/chains');
 if(leaseReader.chainId!==base.id)throw new Error('paid providers settle on Base');
 const chain=await settlementChain({config,leaseReader,chainVerifier});
 const [proof,gas]=await Promise.all([fs.readFile(config.proofKeyFile,'utf8'),fs.readFile(config.gasKeyFile,'utf8')]);
 const proofAccount=privateKeyToAccount(proof.trim()),account=privateKeyToAccount(gas.trim());
 const client=chain.client,wallet=chain.wallet(account);
 const settlements=new Map();
 const cosign=hostId=>async({receipt,runnerSignature,anchorHash})=>{
  const p=(await providers()).find(x=>x.hostId===hostId);if(!p)throw new Error('the paid provider is not in the directory');
  const r=await fetchFn(`http://${p.address}:${p.ports.control}/v1/receipt`,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({receipt:receiptToJSON(receipt),runnerSignature,anchorHash})});
  const b=await r.json().catch(()=>({}));if(!r.ok||typeof b.signature!=='string')throw new Error('provider co-signature refused: '+(b.error||r.status));
  return b.signature;
 };
 const settlementFor=hostId=>{
  if(!settlements.has(hostId))settlements.set(hostId,new ProviderUSDCSettlement({providerId:hostId,cosign:cosign(hostId),directory:path.join(directory,hostId.slice(2,18)),
   transactionDirectory:path.join(directory,'transactions'),leaseReader,proofAccount,wallet,client,maxPending6:config.maxPending6,log}).start());
  return settlements.get(hostId);
 };
 const paid=new PaidNetwork({directory,leaseReader,settlementFor,log});
 paid.close=async()=>{for(const s of settlements.values())await (await s).close().catch(()=>{});};
 return paid;
}
