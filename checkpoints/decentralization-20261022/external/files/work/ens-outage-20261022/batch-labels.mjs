import fs from 'node:fs';
import {createPublicClient,http,parseAbi} from '../enclave/node_modules/viem/_esm/index.js';
import {LEDGER_ABI} from '../enclave/network/lease-gas-owner.mjs';
const p=JSON.parse(fs.readFileSync(new URL('./batch-proposal.json',import.meta.url)));
const catalog='0x18419ca2b502d423a8de6269aeee171a378626e3',ledger='0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B';
const abi=parseAbi(['function getApp(bytes32) view returns ((bytes32 appId,address publisher,string slug,string name,string description,uint32 versionCount,uint64 createdAt,uint64 updatedAt,bool active))']);
const blockNumber=BigInt(p.evidence.blockNumber);
const reads=await Promise.all(['https://mainnet.base.org','https://base-rpc.polkachu.com'].map(async url=>{
 const c=createPublicClient({transport:http(url,{retryCount:0,timeout:15000})});if(await c.getChainId()!==8453)throw Error('wrongchain');
 const ds=await c.multicall({multicallAddress:'0xcA11bde05977b3631167028862bE2a173976CA11',allowFailure:false,blockNumber,contracts:p.rows.map(r=>({address:ledger,abi:LEDGER_ABI,functionName:'get',args:[r.id]}))});
 const refs=ds.map(d=>{const a=d.appRef.match(/^catalog:\/\/(0x[0-9a-fA-F]{64})\/([0-9]+)$/);if(!a)throw Error('badref');return a;});
 const apps=await c.multicall({multicallAddress:'0xcA11bde05977b3631167028862bE2a173976CA11',allowFailure:false,blockNumber,contracts:refs.map(a=>({address:catalog,abi,functionName:'getApp',args:[a[1]]}))});
 return {url,rows:apps.map((a,i)=>{if(a.appId.toLowerCase()!==refs[i][1].toLowerCase()||ds[i].id.toLowerCase()!==p.rows[i].id)throw Error('identity mismatch');return {id:p.rows[i].id,slug:a.slug,name:a.name,appRef:ds[i].appRef};})};
}));
if(JSON.stringify(reads[0].rows)!==JSON.stringify(reads[1].rows))throw Error('metadata disagrees');
const out={at:new Date().toISOString(),block:p.evidence.blockNumber,catalog,agreeing:reads.map(r=>r.url),rows:reads[0].rows};fs.writeFileSync(new URL('./batch-labels.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
