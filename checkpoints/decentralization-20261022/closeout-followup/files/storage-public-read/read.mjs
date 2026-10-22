// Public eth_call only; no wallet, session, signing, private config, or transaction path.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const base=path.dirname(new URL(import.meta.url).pathname);
const repo=path.resolve(base,'../measured-image-build/src');
const {createPublicClient,http,hexToString}=await import(pathToFileURL(path.resolve(base,'../../enclave/node_modules/viem/_esm/index.js')));
const abi=n=>JSON.parse(fs.readFileSync(path.join(repo,'contracts',n+'.abi.json'),'utf8'));
const urls=['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base.drpc.org'];
const clients=urls.map(url=>createPublicClient({transport:http(url,{timeout:8000,retryCount:0})}));
const stringify=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
const heads=await Promise.allSettled(clients.map(c=>c.getBlockNumber({cacheTime:0})));
const good=heads.flatMap((r,i)=>r.status==='fulfilled'?[{i,block:r.value}]:[]);
if(good.length<2)throw Error('fewer than two RPC heads');
const blockNumber=good.map(x=>x.block).sort((a,b)=>a<b?-1:a>b?1:0).at(-2);
const evidence=[];
async function quorum(args){
 const rows=await Promise.allSettled(clients.map(c=>c.readContract({...args,blockNumber})));
 const groups=new Map();rows.forEach((r,i)=>{if(r.status==='fulfilled'){const k=stringify(r.value);const g=groups.get(k)||{value:r.value,agree:[]};g.agree.push(urls[i]);groups.set(k,g);}});
 const best=[...groups.values()].sort((a,b)=>b.agree.length-a.agree.length)[0];
 if(!best||best.agree.length<2)throw Error('no 2/3 agreement: '+args.functionName);
 evidence.push({functionName:args.functionName,address:args.address,agree:best.agree});return best.value;
}
const book='0xab214342d5A490150A4A977063A2f88E21F80907';
const [keys,values]=await quorum({address:book,abi:[{type:'function',name:'all',stateMutability:'view',inputs:[],outputs:[{type:'bytes32[]'},{type:'address[]'}]}],functionName:'all'});
const bindings=Object.fromEntries(keys.map((k,i)=>[hexToString(k).replace(/\0+$/,''),values[i]]));
for(const k of ['deployments','appCatalog'])if(!/^0x[0-9a-fA-F]{40}$/.test(bindings[k])||/^0x0{40}$/.test(bindings[k]))throw Error('invalid address book '+k);
const id='0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238';
const deployment=await quorum({address:bindings.deployments,abi:abi('EnclaveDeployments'),functionName:'get',args:[id]});
const match=/^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d+)$/.exec(deployment.appRef);
if(!match)throw Error('unexpected appRef shape');
const appId=match[1],index=BigInt(match[2]),catalog=bindings.appCatalog;
const app=await quorum({address:catalog,abi:abi('EnclaveAppCatalog'),functionName:'getApp',args:[appId]});
if(app.slug!=='sia-s3')throw Error('wrong app');
const version=await quorum({address:catalog,abi:abi('EnclaveAppCatalog'),functionName:'getVersion',args:[appId,index]});
const configCid=await quorum({address:catalog,abi:abi('EnclaveAppCatalog'),functionName:'versionConfigCid',args:[appId,index]});
const out={at:new Date().toISOString(),readOnly:true,blockNumber,book,bindings:{deployments:bindings.deployments,appCatalog:catalog},deployment,app,versionIndex:index,version,configCid,evidence,leaseExpiredAtRead:Number(deployment.leaseUntil)*1000<Date.now(),limitations:['Chain snapshot only; no serving-endpoint health or runtime readiness proof.','Any config CID content is not retrieved by this probe.']};
fs.writeFileSync(path.join(base,'result.json'),JSON.stringify(JSON.parse(stringify(out)),null,2)+'\n');
console.log(stringify({ok:true,blockNumber,version:version.version,publisher:app.publisher,active:deployment.active,leaseExpired:out.leaseExpiredAtRead,configCid,evidenceCalls:evidence.length}));
