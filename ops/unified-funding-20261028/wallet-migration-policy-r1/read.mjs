import fs from 'node:fs';
import {parseAbi,stringToHex,keccak256} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-kvm-guest/node_modules/viem/_esm/index.js';
import {sessionVaultAbi} from '/home/steven/Documents/Codex/2026-10-23/it/work/wallet-release-ui-r1-20261029/readonly-reference/sessions.live.js';
import {QuorumChain} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/cli/independent.mjs';
const inventory=JSON.parse(fs.readFileSync(new URL('../wallet-ownership-inventory-r2/quorum-result.json',import.meta.url)));
const vault='0xB794C4DD0e1C5E6B72281799F282BfdE7654345D',book='0xab214342d5A490150A4A977063A2f88E21F80907';
const sid='0x4a59ff5d7316635d4ea1592c64c4bd3b5a642130d3197f30545f1bf2e680cb5a';
const abi=parseAbi(['function addr(bytes32) view returns(address)','function beneficialOwnerOf(bytes32) view returns(address)','function policyOf(bytes32) view returns(address,uint64,uint64,bytes32,bool,bytes)']);
const out={capturedAt:new Date().toISOString(),readOnly:true,scope:'Known live API session observed in user browser plus public held and active secret-policy metadata only. Not a complete session census. No secret bundle read, policy update, signature or release.',vault,book,sid};
try{
 const q=new QuorumChain({rpcs:['https://api.enclave.host/rpc/base','https://base-mainnet.public.blastapi.io','https://base-rpc.publicnode.com'],quorum:2,timeoutMs:10000});
 out.snapshot=await q.snapshot(async(c,blockNumber)=>{
  const r=(address,a,functionName,args=[])=>c.readContract({address,abi:a,functionName,args,blockNumber});
  const vc=await c.getCode({address:vault,blockNumber});if(keccak256(vc)!==inventory.snapshot.value.owners.find(p=>p.owner===vault.toLowerCase()).codeHash)throw Error('vault code drift');
  const [session,legacySecretVault,secretVaultV2,factory]=await Promise.all([r(vault,sessionVaultAbi,'sessionOf',[sid]),r(book,abi,'addr',[stringToHex('secretVault',{size:32})]),r(book,abi,'addr',[stringToHex('secretVaultV2',{size:32})]),r(book,abi,'addr',[stringToHex('sessionVaultFactory',{size:32})])]);
  const [s,live,apps]=session;
  const policies=[];
  for(const a of inventory.snapshot.value.vaultApps){
   const id=a.deployment.id,held=await r(vault,sessionVaultAbi,'held',[id]);
   const row={id,held,backends:[]};
   for(const [kind,address] of [['secretVault',legacySecretVault],['secretVaultV2',secretVaultV2]]){
    if(/^0x0{40}$/i.test(address)){row.backends.push({kind,address,configured:false});continue;}
    const [code,beneficialOwner,policy]=await Promise.all([c.getCode({address,blockNumber}),r(address,abi,'beneficialOwnerOf',[id]),r(address,abi,'policyOf',[id])]);
    row.backends.push({kind,address,configured:true,codeHash:keccak256(code),beneficialOwner,policyOwner:policy[0],policyRev:policy[1],secretRev:policy[2],committeeId:policy[3],paused:policy[4],rulesHash:keccak256(policy[5]),rulesBytes:(policy[5].length-2)/2});
   }
   policies.push(row);
  }
  return {factory,knownSession:{live,actions:s.actions,envs:s.envs,anyApp:s.anyApp,apps,expiresAt:s.expiresAt},policies};
 });
}catch(e){out.error={message:String(e.shortMessage||e.message).slice(0,1500),failures:e.failures??null};process.exitCode=1;}
fs.writeFileSync(new URL('./result.json',import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log(JSON.stringify({error:out.error,knownSession:out.snapshot?.value.knownSession,policyRows:out.snapshot?.value.policies.length},(_,v)=>typeof v==='bigint'?v.toString():v));
