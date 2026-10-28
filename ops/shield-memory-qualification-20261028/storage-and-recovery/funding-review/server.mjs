import httpServer from 'node:http';
import fs from 'node:fs';
import {createPublicClient,http,keccak256,encodeFunctionData,toHex} from '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/viem/_esm/index.js';
import {base} from '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/viem/_esm/chains/index.js';
import {OWNER_ABI,LEDGER_ABI} from '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/network/lease-gas-owner.mjs';
const owner='0x0b2d009c0c9Af05b12100D77F3c815fea822eE61';
const id='0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c';
const reserve='0x12A3f873041Dec436DaA0085B766a399A6fA3639',ledger='0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B';
const reserveHash='0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979';
const ledgerHash='0x71d50076336283e774ba2ef8d5cbf7602e9cdc5dd918a7e7390c743367766682';
const value=20000000000000n;
const tx={from:owner,to:reserve,value:toHex(value),data:encodeFunctionData({abi:OWNER_ABI,functionName:'deposit',args:[id]}),chainId:'0x2105'};
const clients=['https://mainnet.base.org','https://base-mainnet.public.blastapi.io'].map(url=>createPublicClient({chain:base,transport:http(url,{timeout:10000,retryCount:0})}));
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
let busy=false;
async function preflight(){
 const heads=await Promise.all(clients.map(async c=>{if(await c.getChainId()!==8453)throw Error('Wrong chain');return c.getBlockNumber()}));
 const blockNumber=heads.reduce((a,b)=>a<b?a:b)-3n;
 const results=await Promise.all(clients.map(async c=>{
  const block=await c.getBlock({blockNumber});if(Math.abs(Date.now()/1000-Number(block.timestamp))>60)throw Error('Stale block');
  for(const[address,expected]of[[reserve,reserveHash],[ledger,ledgerHash]])if(keccak256(await c.getCode({address,blockNumber}))!==expected)throw Error('Contract code changed');
  const d=await c.readContract({address:ledger,abi:LEDGER_ABI,functionName:'get',args:[id],blockNumber});
  if(d.id.toLowerCase()!==id||d.owner.toLowerCase()!==owner.toLowerCase()||!d.active)throw Error('Deployment identity, owner or active state changed');
  const r=await c.readContract({address:reserve,abi:OWNER_ABI,functionName:'reserveOf',args:[id,owner],blockNumber});
  if(r.balanceWei>=value)throw Error('Reserve already funded; stop and ask for verification');
  await c.call({account:owner,to:reserve,data:tx.data,value,blockNumber});
  const gas=await c.estimateGas({account:owner,to:reserve,data:tx.data,value,blockNumber});if(gas>300000n)throw Error('Unexpected gas estimate');
  return {hash:block.hash,owner:d.owner,reserveWei:r.balanceWei,compute6:d.balance6,gas};
 }));
 if(json(results[0])!==json(results[1]))throw Error('Public providers disagree');
 return {checkedAt:new Date().toISOString(),blockNumber,tx,state:results[0]};
}
const html=fs.readFileSync(new URL('./index.html',import.meta.url));
httpServer.createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'");
 if(req.headers.host!=='127.0.0.1:39783'||req.method!=='GET'){res.writeHead(403).end();return;}
 if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
 if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(new URL('./app.js',import.meta.url)));return;}
 if(req.url!=='/preflight'){res.writeHead(404).end();return;}
 if(busy){res.writeHead(429).end('Busy');return;}busy=true;
 try{res.setHeader('Content-Type','application/json');res.end(json(await preflight()));}
 catch(e){res.writeHead(409,{'Content-Type':'application/json'}).end(json({error:e.shortMessage||e.message}));}
 finally{busy=false;}
}).listen(39783,'127.0.0.1',()=>console.log('Review only: http://127.0.0.1:39783 ; server has no signer or broadcast route'));
