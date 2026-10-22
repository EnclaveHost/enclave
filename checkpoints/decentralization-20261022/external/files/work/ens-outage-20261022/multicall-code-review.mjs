import fs from 'node:fs';
import {keccak256} from '../enclave/node_modules/viem/_esm/index.js';
const address='0xcA11bde05977b3631167028862bE2a173976CA11';
const endpoints=[['https://mainnet.base.org',8453],['https://base-rpc.publicnode.com',8453],['https://ethereum-rpc.publicnode.com',1],['https://eth.drpc.org',1]];
async function run([url,chain]) {
 let id=0;
 const rpc=async(method,params=[])=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();if(j.error)throw Error(j.error.message);return j.result;};
 try{const actual=Number(BigInt(await rpc('eth_chainId')));if(actual!==chain)throw Error('chain mismatch');const block=await rpc('eth_blockNumber');const code=await rpc('eth_getCode',[address,block]);return {url,chain,block:String(BigInt(block)),bytes:(code.length-2)/2,hash:keccak256(code)};}catch(e){return {url,chain,error:e.message};}
}
const reads=await Promise.all(endpoints.map(run));const good=reads.filter(x=>x.hash&&x.bytes>0);
const result={at:new Date().toISOString(),address,reads,match:good.length===4&&new Set(good.map(x=>x.hash)).size===1,scope:'Read-only runtime hash comparison on Base and Ethereum. No transaction or wallet action.'};
fs.writeFileSync(new URL('./multicall-code-review.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(!result.match)process.exitCode=1;
