import fs from 'node:fs';
import {parseAbi,keccak256} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-kvm-guest/node_modules/viem/_esm/index.js';
import {QuorumChain} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/cli/independent.mjs';
const inventory=JSON.parse(fs.readFileSync(new URL('../wallet-ownership-inventory-r2/quorum-result.json',import.meta.url)));
const catalog=JSON.parse(fs.readFileSync(new URL('../wallet-migration-catalog-tail-r1/result.json',import.meta.url)));
const addresses=[...new Set([...inventory.snapshot.value.owners.filter(p=>p.classification==='unclassified-contract').map(p=>p.owner),...catalog.snapshot.value.publishers.filter(p=>p.classification==='unclassified-contract').map(p=>p.publisher)])];
const factory='0x00bB59c40768aA56E292b4E789f9f3B5826E3a8d';
const abi=parseAbi(['function isVault(address) view returns(bool)','function owner() view returns(address)','function factory() view returns(address)','function vaultFor(address) view returns(address)']);
const out={capturedAt:new Date().toISOString(),readOnly:true,scope:'Classify previously unclassified public owner/publisher addresses against historical factory v1 from committed sessions-base.json. Newly observed runtime is not independently source-verified here; this does not authorize any mutation.',factory,addresses};
try{
 const q=new QuorumChain({rpcs:['https://api.enclave.host/rpc/base','https://base-mainnet.public.blastapi.io','https://base-rpc.publicnode.com'],quorum:2,timeoutMs:10000});
 out.snapshot=await q.snapshot(async(c,blockNumber)=>{
  const r=(address,functionName,args=[])=>c.readContract({address,abi,functionName,args,blockNumber});
  const factoryCode=await c.getCode({address:factory,blockNumber});if(!factoryCode||factoryCode==='0x')throw Error('historical factory absent');
  const owners=[];
  for(const address of addresses){
   const [code,known]=await Promise.all([c.getCode({address,blockNumber}),r(factory,'isVault',[address])]);
   const prior=inventory.snapshot.value.owners.find(p=>p.owner===address)||catalog.snapshot.value.publishers.find(p=>p.publisher===address);
   if(!code||keccak256(code)!==prior.codeHash)throw Error('owner code drift');
   const v={address,codeHash:keccak256(code),codeBytes:(code.length-2)/2,codePrefix:code.slice(0,202),factoryV1Recognizes:known};
   if(known){
    const [owner,reportedFactory]=await Promise.all([r(address,'owner'),r(address,'factory')]);
    const expectedVault=await r(factory,'vaultFor',[owner]);
    Object.assign(v,{controllingWallet:owner,reportedFactory,expectedVault,bindingsAgree:reportedFactory.toLowerCase()===factory.toLowerCase()&&expectedVault.toLowerCase()===address,matchesUser:owner.toLowerCase()===inventory.wallet.toLowerCase(),runtimeQualification:'historical factory address plus agreed current observations; source/implementation qualification still required'});
   }
   owners.push(v);
  }
  return {factoryCodeHash:keccak256(factoryCode),owners};
 });
}catch(e){out.error={message:String(e.shortMessage||e.message).slice(0,1500),failures:e.failures??null};process.exitCode=1;}
fs.writeFileSync(new URL('./result.json',import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log(JSON.stringify({error:out.error,value:out.snapshot?.value},(_,v)=>typeof v==='bigint'?v.toString():v));
