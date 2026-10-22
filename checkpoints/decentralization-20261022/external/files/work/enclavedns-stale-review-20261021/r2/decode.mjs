// Read-only, local: decode the writer's unsigned calldata with the repo ABIs and compare to v4 + the release artifact.
import fs from 'node:fs';
const W='/home/steven/Documents/Codex/2026-10-18/wo/work/enclave', R='/home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2';
const viem=await import(W+'/node_modules/viem/_esm/index.js');
const abi=(f,c=f)=>JSON.parse(fs.readFileSync(`${W}/contracts/foundry/out/${f}.sol/${c}.json`,'utf8')).abi;
const CAT=abi('EnclaveAppCatalog'),DEP=abi('EnclaveDeployments'),SV=abi('SessionVault');
const u=JSON.parse(fs.readFileSync(R+'/unsigned-txs.json','utf8')), v4=JSON.parse(fs.readFileSync(R+'/v4-version.json','utf8'));
const auth=JSON.parse(fs.readFileSync(R+'/../release-0.1.5/authority.json','utf8'));
const out={};
const p=viem.decodeFunctionData({abi:CAT,data:u.publish.tx.data});
out.publish={fn:p.functionName,to:u.publish.tx.to,from:u.publish.tx.from,chainId:u.publish.tx.chainId,value:u.publish.tx.value,
  slug:p.args[0],name:p.args[1],version:p.args[3],cid:p.args[4],resources:p.args[5].map(String),ports:p.args[6],price:String(p.args[8]),
  descEqualsCatalog:p.args[2]===auth.catalog.app.description,nameEqualsCatalog:p.args[1]===auth.catalog.app.name,
  configEqualsV4:p.args[7]===v4.version4.config, resourcesEqualV4:JSON.stringify(p.args[5].map(Number))===JSON.stringify([v4.version4.vramMb,v4.version4.gpuGflops,v4.version4.memMb,v4.version4.cpuGflops]),
  portsEqualV4:p.args[6]===v4.version4.ports, catalogIsBookEntry:u.publish.tx.to.toLowerCase()===auth.catalog.address.toLowerCase()};
out.v4={version:v4.version4.version,cid:v4.version4.cid,price:String(v4.version4.price??''),keys:Object.keys(v4.version4)};
for(const k of ['upgrade','rollback']){const t=u[k].tx;const o=viem.decodeFunctionData({abi:SV,data:t.data});const inner=viem.decodeFunctionData({abi:DEP,data:o.args[1]});
  out[k]={fn:o.functionName,to:t.to,toIsVault:t.to.toLowerCase()===auth.vault.address.toLowerCase(),from:t.from,chainId:t.chainId,value:t.value,target:o.args[0],targetIsLedger:o.args[0].toLowerCase()===auth.deployment.ledger.toLowerCase(),
    inner:inner.functionName,deployment:inner.args[0],deploymentMatches:inner.args[0].toLowerCase()===auth.deployment.id.toLowerCase(),appRef:inner.args[1]};}
out.authority={owner:auth.vault?.owner,catalogOwner:auth.catalog?.owner,publisher:auth.catalog?.app?.publisher,deploymentOwner:auth.deployment?.owner,appRefNow:auth.deployment?.appRef,versions:auth.catalog?.versions?.length};
out.sims={publish:u.publish.simulation,upgrade:u.upgrade.simulation,negative:u.negativeControl.simulation,expectIndex:u.publish.expectIndex};
console.log(JSON.stringify(out,(k,v)=>typeof v==='bigint'?v.toString():v,1));
