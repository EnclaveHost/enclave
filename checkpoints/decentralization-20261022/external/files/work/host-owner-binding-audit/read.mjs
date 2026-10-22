import fs from 'node:fs';
import {encodeFunctionData,decodeFunctionResult,parseAbi,keccak256,toBytes,stringToHex} from '../enclave/node_modules/viem/_esm/index.js';
import {PRODUCTION_BOOK,PRODUCTION_HOST_OWNERSHIP,PRODUCTION_RPCS} from '../enclave/network/platform-host-policy-config.mjs';
const alternative='0xf5e9e6c02449001f6e8e95e5d87413f2cb6790ea';
const endpoint='https://api.enclave.host/t/metal0',id=keccak256(toBytes(endpoint));
const abi=parseAbi(['function owner() view returns(address)','function registry() view returns(address)','function addr(bytes32) view returns(address)','function authority(bytes32) view returns(address owner,address pendingOwner,uint64 revision,bytes32 policyHash)']);
let n=0;
async function rpc(url,method,params){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++n,method,params}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();if(j.error)throw Error(j.error.message);return j.result;}
const heads=await Promise.all(PRODUCTION_RPCS.map(async url=>{try{return {url,head:await rpc(url,'eth_getBlockByNumber',['latest',false])}}catch(e){return {url,error:e.message}}}));
const available=heads.filter(x=>x.head);if(available.length<2)throw Error('Fewer than 2 RPC headers');
const at='0x'+(available.map(x=>BigInt(x.head.number)).reduce((a,b)=>a<b?a:b)-2n).toString(16);
const rows=await Promise.all(PRODUCTION_RPCS.map(async url=>{try{
 const head=await rpc(url,'eth_getBlockByNumber',[at,false]);
 async function call(to,fn,args=[]){return decodeFunctionResult({abi,functionName:fn,data:await rpc(url,'eth_call',[{to,data:encodeFunctionData({abi,functionName:fn,args})},{blockHash:head.hash,requireCanonical:true}])});}
 const [bookOwner,bookRegistry,prodRegistry,altRegistry,prod,alt]=await Promise.all([call(PRODUCTION_BOOK,'owner'),call(PRODUCTION_BOOK,'addr',[stringToHex('registry',{size:32})]),call(PRODUCTION_HOST_OWNERSHIP,'registry'),call(alternative,'registry'),call(PRODUCTION_HOST_OWNERSHIP,'authority',[id]),call(alternative,'authority',[id])]);
 return {url,block:head.number,hash:head.hash,timestamp:head.timestamp,facts:{bookOwner,bookRegistry,production:{address:PRODUCTION_HOST_OWNERSHIP,registry:prodRegistry,authority:prod},alternative:{address:alternative,registry:altRegistry,authority:alt}}};
}catch(e){return {url,error:e.message}}}));
const json=(x)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v);
const groups=new Map();for(const row of rows.filter(x=>x.facts)){const k=json({hash:row.hash,facts:row.facts});groups.set(k,[...(groups.get(k)||[]),row.url]);}
const best=[...groups.entries()].sort((a,b)=>b[1].length-a[1].length)[0];
const result={at:new Date().toISOString(),readOnly:true,endpoint,id,requiredAgreement:3,agreement:best?.[1].length||0,verified:!!best&&best[1].length>=3,rows};
fs.writeFileSync(new URL('../../outputs/decentralization-audit/host-owner-binding-live.json',import.meta.url),JSON.stringify(result,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log(json(result));if(!result.verified)process.exitCode=2;
