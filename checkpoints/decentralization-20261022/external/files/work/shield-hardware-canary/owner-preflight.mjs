// Public chain reads only: no key store, wallet client, transaction or host mutation.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {QuorumChain,validateRpcOrigins} from '../enclave/cli/independent.mjs';
import {sessionVaultAbi} from '../enclave/sdk/sessions/dist/node.mjs';
import {keccak256} from '../enclave/node_modules/viem/_esm/index.js';
const profile=JSON.parse(fs.readFileSync('outputs/authority-profile/network-profile-base.json'));
const old=JSON.parse(fs.readFileSync('work/bootstrap-hardware/preflight.json'));
const catalogABI=JSON.parse(fs.readFileSync('work/enclave/contracts/EnclaveAppCatalog.abi.json'));
const registryABI=JSON.parse(fs.readFileSync('work/enclave/contracts/EnclaveRegistry.abi.json'));
const rpcs=validateRpcOrigins(['https://base-rpc.publicnode.com','https://base.drpc.org','https://base.public.blockpi.network/v1/rpc/public','https://mainnet.base.org']);
const q=new QuorumChain({rpcs,quorum:2});
const snapshot=await q.snapshot(async(c,blockNumber)=>{
 for(const name of ['appCatalog','registry','deployments']) {
  const p=profile.contracts[name];if(!p?.codeHash)throw Error('missing pin '+name);
  const code=await c.getCode({address:p.address,blockNumber});if(!code||keccak256(code)!==p.codeHash)throw Error('code pin changed '+name);
 }
 const read=(address,abi,functionName,args=[])=>c.readContract({address,abi,functionName,args,blockNumber});
 const cat=profile.contracts.appCatalog.address,reg=profile.contracts.registry.address;
 const session=await read(old.session.vault,sessionVaultAbi,'sessionOf',[old.session.sid]);
 const appCount=Number(await read(cat,catalogABI,'appCount'));
 if(appCount>1000)throw Error('catalog scan limit');
 const apps=[];
 for(let start=0;start<appCount;start+=20){
  const page=await read(cat,catalogABI,'getAppsPage',[BigInt(start),20n]);
  apps.push(...page.filter(a=>['hello-world','enclavedns','hookbin'].includes(a.slug)));
 }
 const selected=[];
 for(const a of apps){
  if(BigInt(a.versionCount)===0n)continue;
  const index=BigInt(a.versionCount)-1n;
  const v=await read(cat,catalogABI,'getVersion',[a.appId,index]);
  selected.push({appId:a.appId,slug:a.slug,publisher:a.publisher,index,version:v});
 }
 const schema=Number(await read(reg,registryABI,'registrySchema'));
 if(schema<1||schema>5)throw Error('unsupported registry schema');
 const abi=structuredClone(registryABI);
 const page=abi.find(x=>x.name==='getPage');
 // getPage has tuple[] rows; the registry's deployed schema determines its fields.
 const tuple=page.outputs.find(x=>x.type==='tuple[]');
 if(!tuple)throw Error('registry page ABI shape changed');
 tuple.components.length=[0,7,9,10,11,13][schema];
 const hosts=await read(reg,abi,'getPage',[0n,64n]);
 return {session:{vault:old.session.vault,sid:old.session.sid,live:session[1],apps:session[2],state:session[0]},appCount,apps:selected,registrySchema:schema,hosts};
});
if(snapshot.timestamp+120000<Date.now())throw Error('snapshot expired during preflight');
const out={at:new Date().toISOString(),readOnly:true,blockNumber:snapshot.blockNumber,blockHash:snapshot.blockHash,agreeingRPCs:snapshot.agreeing,totalRPCs:snapshot.peers,sourceSha256:createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),...snapshot.value,limitations:['Public inputs and existing session capability only. No new deployments, lease claims, package commitments or VM launches occurred.','Guest authority requires a current lease; materialize needLease:false does not bypass the guest chain check.','Canary guest phases still need exact owner-authorized deployment/package/lease inputs and isolated egress configuration.']};
const text=JSON.stringify(out,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
fs.writeFileSync('outputs/windows-canary-owner-preflight.json',text);
console.log(JSON.stringify({block:String(snapshot.blockNumber),agreeing:snapshot.agreeing,sessionLive:out.session.live,appCount:out.appCount,selectedApps:out.apps.map(a=>({slug:a.slug,appId:a.appId,index:String(a.index),ports:a.version.ports})),hostCount:out.hosts.length}));
