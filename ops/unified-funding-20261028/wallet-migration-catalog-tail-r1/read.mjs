import fs from 'node:fs';
import {parseAbi,keccak256,encodeFunctionData} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-kvm-guest/node_modules/viem/_esm/index.js';
import {QuorumChain} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/cli/independent.mjs';
const prior=JSON.parse(fs.readFileSync(new URL('../wallet-ownership-inventory-r2/quorum-result.json',import.meta.url)));
const {ledger,wallet}=prior, catalog='0x18419ca2b502d423a8de6269aeee171a378626e3';
const factory='0x1F5c887c0cDF491b16AB6c449abAfDF9B2ec9C9C';
const factoryHash=prior.snapshot.value.factoryCodeHash;
const abi=parseAbi([
 'function owner() view returns(address)', 'function factory() view returns(address)',
 'function isVault(address) view returns(bool)','function vaultFor(address) view returns(address)',
 'function appCount() view returns(uint256)',
 'function getAppsPage(uint256,uint256) view returns((bytes32 appId,address publisher,string slug,string name,string description,uint32 versionCount,uint64 createdAt,uint64 updatedAt,bool active)[])',
 'function transferApp(bytes32,address)', 'function proofRequired() view returns(bool)',
 'function provenUntil(bytes32) view returns(uint64)',
 'function earnOf(bytes32) view returns(uint256,uint256,uint64)',
 'function refundableOf(bytes32) view returns(uint256)',
 'function ownerEscrow6(bytes32) view returns(uint256)',
 'function prover() view returns(address)'
]);
const out={capturedAt:new Date().toISOString(),readOnly:true,scope:'Catalog lineage ownership and exact legacy escrow/proof-tail observation. No signatures, funds, writes, secret payloads, arbitrary owner authority or finality claim.',ledger,catalog,wallet};
async function observe(c,blockNumber){
 const r=(address,functionName,args=[])=>c.readContract({address,abi,functionName,args,blockNumber});
 const [fc,lc,cc,count,admin,proofRequired,prover]=await Promise.all([c.getCode({address:factory,blockNumber}),c.getCode({address:ledger,blockNumber}),c.getCode({address:catalog,blockNumber}),r(catalog,'appCount'),r(catalog,'owner'),r(ledger,'proofRequired'),r(ledger,'prover')]);
 if(keccak256(fc)!==factoryHash||keccak256(lc)!==prior.snapshot.value.ledgerCodeHash)throw Error('factory/ledger changed');
 if(count>512n)throw Error('catalog enumeration bound exceeded');
 const apps=[];
 for(let start=0n;start<count;start+=32n)apps.push(...await r(catalog,'getAppsPage',[start,32n]));
 if(BigInt(apps.length)!==count||new Set(apps.map(a=>a.appId)).size!==apps.length)throw Error('incomplete catalog enumeration');
 const publishers=[];
 for(const publisher of [...new Set(apps.map(a=>a.publisher.toLowerCase()))]){
  const [known,code]=await Promise.all([r(factory,'isVault',[publisher]),c.getCode({address:publisher,blockNumber})]);
  const p={publisher,codeHash:code&&code!=='0x'?keccak256(code):null,classification:publisher===wallet.toLowerCase()?'target-wallet':code&&code!=='0x'?'unclassified-contract':'externally-owned-account'};
  if(known){
   const [owner,f]=await Promise.all([r(publisher,'owner'),r(publisher,'factory')]);
   if(f.toLowerCase()!==factory.toLowerCase()||(await r(factory,'vaultFor',[owner])).toLowerCase()!==publisher)throw Error('publisher vault provenance mismatch');
   Object.assign(p,{classification:'recognized-legacy-session-vault',controllingWallet:owner});
  }
  publishers.push(p);
 }
 const vaultApps=[];
 for(const app of apps){
  const p=publishers.find(p=>p.publisher===app.publisher.toLowerCase());
  if(p.classification!=='recognized-legacy-session-vault')continue;
  let simulation;
  try {await c.call({account:admin,to:catalog,data:encodeFunctionData({abi,functionName:'transferApp',args:[app.appId,p.controllingWallet]}),blockNumber});simulation={ok:true,caller:admin,authorityNotEstablished:true};}
  catch(e){simulation={ok:false,message:String(e.shortMessage||e.message).slice(0,500)};}
  vaultApps.push({app,controllingWallet:p.controllingWallet,simulation});
 }
 const tails=[];
 for(const a of prior.snapshot.value.vaultApps.filter(a=>!a.escrowGateClear)){
  const id=a.deployment.id;
  const [provenUntil,earn,refundable6,ownerEscrow6]=await Promise.all([r(ledger,'provenUntil',[id]),r(ledger,'earnOf',[id]),r(ledger,'refundableOf',[id]),r(ledger,'ownerEscrow6',[id])]);
  tails.push({id,provenUntil,earn,refundable6,ownerEscrow6,priorLeaseUntil:a.deployment.leaseUntil,note:'Prior lease snapshot is explicitly historical; no settlement or refund executed.'});
 }
 return {count,admin,adminMatchesUser:admin.toLowerCase()===wallet.toLowerCase(),catalogCodeHash:keccak256(cc),proofRequired,prover,publishers,apps,vaultApps,tails};
}
try {
 const q=new QuorumChain({rpcs:['https://api.enclave.host/rpc/base','https://base-mainnet.public.blastapi.io','https://base-rpc.publicnode.com'],quorum:2,timeoutMs:10000});
 out.snapshot=await q.snapshot(observe);
}catch(e){out.error={message:String(e.shortMessage||e.message).slice(0,1500),failures:e.failures??null};process.exitCode=1;}
fs.writeFileSync(new URL('./result.json',import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log(JSON.stringify({error:out.error,count:out.snapshot?.value.count,vaultApps:out.snapshot?.value.vaultApps,tails:out.snapshot?.value.tails},(_,v)=>typeof v==='bigint'?v.toString():v));
