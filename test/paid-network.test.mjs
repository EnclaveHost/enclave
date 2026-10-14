// Paid Enclave-network providers: the provider's gate, meter and receipt co-signature (network/wg-provider/paid.mjs), the
// host's eligibility and metered debits (network/paid-network.mjs) and the manager closing a circuit whose debit is refused.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {EventEmitter} from 'node:events';import {randomBytes} from 'node:crypto';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import {recoverMessageAddress} from 'viem';
import {paidGate,PeerMeter,createReceiptCosigner,receiptToJSON,receiptFromJSON} from '../network/wg-provider/paid.mjs';
import {WgProvider,peerRequestMessage} from '../network/wg-provider/provider.mjs';
import {paidEligible,PaidNetwork} from '../network/paid-network.mjs';
import {ProviderUSDCSettlement,providerReceiptDigest} from '../network/provider-settlement.mjs';
import {EnclaveNetworkManager} from '../network/wg-manager.mjs';
import {signNetworkPolicy} from '../network/network-policy.mjs';

const id='0x'+'aa'.repeat(32),runner='0x'+'bb'.repeat(32),hostId='0x'+'dd'.repeat(32),other='0x'+'ee'.repeat(32);
const contract='0x'+'22'.repeat(20),ledger='0x'+'33'.repeat(20),hash='0x'+'cc'.repeat(32);
const hostProof=privateKeyToAccount(generatePrivateKey()),providerProof=privateKeyToAccount(generatePrivateKey());
const runnerOperator=privateKeyToAccount(generatePrivateKey()),owner=privateKeyToAccount(generatePrivateKey());
const tmp=async t=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'paid-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;};
// a lease as LeaseReader returns it, with the owner's on-chain authorization of one paid provider (hostId, 1000/GiB)
const lease=(over={},conn={})=>({id,runner,owner:owner.address,runnerOperator:runnerOperator.address,runnerProofKey:hostProof.address,active:true,isPublic:true,chainId:8453,deployments:ledger,
 validUntil:190000,leaseUntil:200000,blockNumber:'100',blockHash:hash,balance6:'100000',bandwidthBackingRequired6:'0',
 connectivity:{address:contract,viaProviders:true,owner:owner.address,nonce:'3',expires:200,maxPricePerGiB6:'1000',budget6:'10000',spent6:'0',
  providers:[{id:hostId,qualified:true,active:true,qualifiedUntil:200,pricePerGiB6:'1000',operator:providerProof.address,proofKey:providerProof.address}],...conn},...over});
const NOW=100000;

test('a paid provider admits an app only under the owner\'s current on-chain authorization of it, with budget left',()=>{
 assert.equal(paidGate({lease:lease(),hostId,pricePerGiB6:1000,now:NOW}),'3');
 for(const [why,l,h=hostId,price=1000] of [
  ['not authorized at all',lease({},{viaProviders:false})],['another provider',lease(),other],['a different price',lease(),hostId,1500],
  ['path over the owner\'s cap',lease({},{maxPricePerGiB6:'999'})],['budget spent',lease({},{spent6:'10000'})],['authorization expired',lease({},{expires:50})],
  ['not qualified on chain',lease({},{providers:[{...lease().connectivity.providers[0],qualified:false}]})],['no connectivity',lease({connectivity:undefined})],['not a registry host',lease(),null]])
  assert.throws(()=>paidGate({lease:l,hostId:h,pricePerGiB6:price,now:NOW}),undefined,why);
 // the host applies the same rule; free providers are always eligible
 assert.equal(paidEligible(lease(),{pricePerGiB6:1000,kind:'community',hostId},NOW),true);
 assert.equal(paidEligible(lease({},{spent6:'10000'}),{pricePerGiB6:1000,kind:'community',hostId},NOW),false);
 assert.equal(paidEligible(lease(),{pricePerGiB6:1000,kind:'enclave',hostId:null},NOW),false);
 assert.equal(paidEligible(undefined,{pricePerGiB6:0},NOW),true);
});

test('the provider meters each paid peer durably: counter growth only, a restarted counter counts in full, totals survive a restart',async t=>{
 const dir=await tmp(t);let stats={k1:{rx:100,tx:50},k2:{rx:7,tx:3}};
 const kernel={stats:async()=>stats};const file=path.join(dir,'meter.json');
 const peers=[{key:'k1',deploymentId:id,runner,paidNonce:'3'},{key:'k2',deploymentId:id,runner,paidNonce:'3'},{key:'k3',deploymentId:id,runner,paidNonce:null}];
 const m=await new PeerMeter({file,kernel}).load();
 await m.sample(peers);assert.equal(m.observed({deploymentId:id,runnerId:runner,nonce:'3'}),160n);
 stats={k1:{rx:150,tx:50},k2:{rx:2,tx:1}};await m.sample(peers);   // k1 +50; k2 restarted: +3
 assert.equal(m.observed({deploymentId:id,runnerId:runner,nonce:'3'}),213n);
 assert.equal(m.observed({deploymentId:id,runnerId:runner,nonce:'4'}),0n,'a new on-chain policy starts a new meter');
 const again=await new PeerMeter({file,kernel}).load();assert.equal(again.observed({deploymentId:id,runnerId:runner,nonce:'3'}),213n);
 await again.sample(peers);assert.equal(again.observed({deploymentId:id,runnerId:runner,nonce:'3'}),213n,'no double count after a restart');
});

test('a paid provider grants only authorized apps, meters them, and drops their peers when the authorization ends',async()=>{
 let now=NOW,l=lease();const kernel={peers:new Map(),setPeer:async p=>kernel.peers.set(p.key,p),removePeer:async p=>kernel.peers.delete(p.key),sync:async()=>{},listPeers:async()=>[...kernel.peers.keys()]};
 const policy=await signNetworkPolicy(owner,{version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'enclave-network',fallback:'none',enclaveNetwork:{routes:1,guard:true,maxPricePerGiB6:1000,budget6:10000}});
 const seen=new Map(),sampled=[];
 const p=new WgProvider({config:{providerId:'ab'.repeat(16),hostId,roles:['guard','ingress','egress'],pricePerGiB6:1000,publicAddress:'134.199.235.187',exitKey:randomBytes(32).toString('base64'),guardKey:randomBytes(32).toString('base64'),ports:{exit:51820,guard:51821,control:51822}},
  signer:providerProof,kernel,leases:async()=>l,policyMemory:{get:async k=>seen.get(k),set:async(k,v)=>seen.set(k,v)},verifyOwner:async()=>true,currentPolicy:async()=>policy,domains:async()=>[],now:()=>now});
 p.meterSample=async()=>{sampled.push(now);};p.meterForget=async()=>{};
 const ask=async()=>{const r={version:1,providerId:'ab'.repeat(16),role:'exit',deploymentId:id,runner,wgPublicKey:randomBytes(32).toString('base64'),policy:null,ingress:true,egress:true,issuedAt:now,nonce:randomBytes(16).toString('hex'),expiresAt:now+600000};
  return p.handle({request:r,signature:await runnerOperator.signMessage({message:peerRequestMessage(r)})});};
 l=lease({},{viaProviders:false});await assert.rejects(ask(),/authorization/);
 l=lease();const {grant}=await ask();const peer=[...p.peers.values()][0];assert.equal(peer.paidNonce,'3');assert.ok(grant.clientAddress);
 l=lease({},{spent6:'10000'});await p.sweep();assert.equal(p.peers.size,0,'budget spent: the peer is gone');assert.ok(sampled.length,'metered before removal');
});

test('host and provider sign one receipt for the provider-observed traffic; the provider refuses more than it saw',async t=>{
 const dir=await tmp(t);let observed=5000n;
 const client={readContract:async()=>0n,getBlock:async()=>({hash})},reader={clients:[client,client],get:()=>lease(),refresh:async()=>[lease()]};
 const cosignHTTP=createReceiptCosigner({hostId,proofAccount:providerProof,leaseReader:reader,meter:{observed:()=>observed},sample:async()=>{},now:()=>NOW});
 // the host's settlement asks the provider over JSON, exactly as createPaidNetwork does
 const host=new ProviderUSDCSettlement({providerId:hostId,directory:dir,leaseReader:reader,proofAccount:hostProof,maxPending6:'10',now:()=>NOW,
  cosign:async b=>(await cosignHTTP(JSON.parse(JSON.stringify({receipt:receiptToJSON(b.receipt),runnerSignature:b.runnerSignature,anchorHash:b.anchorHash})))).signature});
 const req={deploymentId:id,policyHash:'p',cumulativeBytes:'4000',cumulativeCost6:'1',pricePerGiB6:'1000',nonce:'3'};
 await host.authorizeDebit(req);
 const s=await host.state.get(id.slice(2)+'-3');
 const out=await host.signedReceipt({id,s,lease:lease(),c:lease().connectivity,head:{hash}});
 const digest=providerReceiptDigest({chainId:8453,connectivity:contract,ledger,receipt:out.receipt,anchorHash:hash});
 assert.equal(await recoverMessageAddress({message:{raw:digest},signature:out.args[1]}),hostProof.address);
 assert.equal(await recoverMessageAddress({message:{raw:digest},signature:out.args[2]}),providerProof.address);
 observed=3999n;await assert.rejects(host.signedReceipt({id,s,lease:lease(),c:lease().connectivity,head:{hash}}),/exceeds provider-observed/);
 assert.throws(()=>receiptFromJSON({...receiptToJSON(out.receipt),extra:1}),/invalid receipt/);
});

test('the host meters paid hops, debits cumulatively, and the manager closes a circuit whose debit is refused',async t=>{
 const dir=await tmp(t);const debits=[];let refuse=false;let l=lease();
 const paid=new PaidNetwork({directory:dir,leaseReader:{get:()=>l},now:()=>NOW,settlementFor:async h=>({authorizeDebit:async d=>{if(refuse)throw new Error('available app USDC or owner bandwidth budget exhausted');debits.push({h,...d});}})});
 const prov=(n,over={})=>({providerId:String(n).repeat(32),address:`44.0.0.${n}`,wgExitKey:'x'+n,wgGuardKey:'g'+n,ports:{exit:51820,guard:51821,control:51822},region:'r'+n,kind:'enclave',hostId:null,
  pricePerGiB6:0,eligibleRoles:['guard','ingress','egress'],qualifiedUntil:Date.now()+600000,...over});
 const paidExit=prov(9,{kind:'community',hostId,pricePerGiB6:1000});
 const admission={allows:()=>true,leases:new Map([[id,{validUntil:Date.now()+600000}]]),proofs:new Map([[id,{validUntil:Date.now()+600000}]])};
 const started=[];
 const runtime={start:async a=>{const c=new EventEmitter();Object.assign(c,{...a,id:'c'+started.length,closed:false,providers:{guard:a.guard,exit:a.exit},address:a.exit.address,egressReady:true,egress:'127.0.0.1:9',stats:{app:{up:0,down:0}},admit(){},async close(){this.closed=true;}});started.push(c);return c;}};
 const policy={version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'enclave-network',fallback:'none',enclaveNetwork:{routes:1,guard:true,maxPricePerGiB6:1000,budget6:10000}};
 // only the paid provider can be the exit (the free ones offer guard only)
 const providers=[prov(1,{eligibleRoles:['guard']}),paidExit];
 const make=p=>new EnclaveNetworkManager({runtime,admission,providers:async()=>providers,probe:async()=>{},publish:async()=>{},paid:p});
 const without=make(null);await without.configure([{deploymentId:id,names:['aaaaaaaa.app.enclave.host'],policy,isPublic:true}]);await without.reconcile();
 assert.equal(without.apps.get(id).circuits.length,0,'a priced provider is never used without paid settlement');
 const m=make(paid);await m.configure([{deploymentId:id,names:['aaaaaaaa.app.enclave.host'],policy,isPublic:true}]);await m.reconcile();
 const c=m.apps.get(id).circuits[0];assert.equal(c.providers.exit.hostId,hostId);
 c.stats={app:{up:300,down:700}};await m.reconcile();
 assert.deepEqual(debits.at(-1),{h:hostId,deploymentId:id,policyHash:`${contract}:3:${hostId}`,cumulativeBytes:'1000',cumulativeCost6:'1',pricePerGiB6:'1000',nonce:'3',counters:{in:'700',out:'300',cost6:'1',units:'1000000'}});
 c.stats={app:{up:400,down:900}};await m.reconcile();assert.equal(debits.at(-1).cumulativeBytes,'1300','cumulative across passes');
 refuse=true;c.stats={app:{up:500,down:900}};await m.reconcile();
 assert.ok(c.closed,'refused debit: the paid circuit is closed');
 assert.equal(m.cooldown.size,0,'a refused debit is not a provider failure: nothing is cooled down');
 l=lease({},{viaProviders:false});refuse=false;await m.reconcile();
 assert.ok(m.apps.get(id).circuits.every(x=>x.providers.exit.hostId!==hostId),'authorization revoked: the paid provider is not chosen again');
});
