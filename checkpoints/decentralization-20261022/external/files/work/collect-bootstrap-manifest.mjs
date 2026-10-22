import {readFileSync,writeFileSync} from 'node:fs';
import {LeaseReader} from './enclave/network/lease-reader.mjs';
const reader=new LeaseReader({rpc:['https://base-rpc.publicnode.com','https://base.drpc.org','https://mainnet.base.org'],addressBook:'0xab214342d5A490150A4A977063A2f88E21F80907'});
const snap=await (await fetch('http://134.199.235.187:8188/v1/network/records')).json();
const ids=snap.publications.map(p=>p.bundle.record.deploymentId);
const rows=await reader.refresh(ids);
const catalog=await reader.bookAddress('appCatalog');
const abi=JSON.parse(readFileSync(new URL('./enclave/contracts/EnclaveAppCatalog.abi.json',import.meta.url)));
const entries=[];
for(const row of rows){
 const m=/^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/.exec(row.appRef);if(!m)throw Error('unsupported app reference');
 const {v,cid}=await reader.agreed(async(c,blockNumber)=>JSON.parse(JSON.stringify({v:(await c.readContract({address:catalog,abi,functionName:'getVersionsPage',args:[m[1],BigInt(m[2]),1n],blockNumber}))[0],cid:await c.readContract({address:catalog,abi,functionName:'versionConfigCid',args:[m[1],BigInt(m[2])],blockNumber})},(_,v)=>typeof v==='bigint'?v.toString():v)));
 let deploymentConfigCid=null;
 if(/^b[a-z2-7]{10,100}$/.test(row.configCid||''))deploymentConfigCid=row.configCid;
 else {try{const options=JSON.parse(row.configCid);if(/^b[a-z2-7]{10,100}$/.test(options.configCid||''))deploymentConfigCid=options.configCid;}catch{}}
 entries.push({deploymentId:row.id,appRef:row.appRef,wasmCid:v.cid,configCid:cid||null,deploymentConfigCid});
}
const release=JSON.parse(readFileSync(new URL('./adapter-release-artifact.json',import.meta.url)));
const cids=[...new Set([...entries.flatMap(e=>[e.wasmCid,e.configCid,e.deploymentConfigCid]).filter(Boolean),release.cid])];
writeFileSync(new URL('../outputs/bootstrap-manifest.json',import.meta.url),JSON.stringify({generatedAt:new Date().toISOString(),catalog,entries,cids,status:'inventory-only; retrieval and independent hosting still require verification'},null,2)+'\n');
console.log({deployments:entries.length,uniqueCids:cids.length});
