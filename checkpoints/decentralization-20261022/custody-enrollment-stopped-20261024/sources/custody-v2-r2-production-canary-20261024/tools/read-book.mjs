// Read-only original book inventory, at one canonical block on two distinct configured RPCs.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {BOOK} from '../driver/clipins.mjs';import {checkRepo} from '../driver/cli.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),pins=JSON.parse(fs.readFileSync(path.join(root,'pins.base.json')));
try{
 checkRepo(pins);const v=await import(pathToFileURL(path.join(pins.repo.path,'node_modules/viem/_esm/index.js')).href);
 const urls=pins.sendRpcs;if(urls.length!==2||new Set(urls.map(x=>new URL(x).hostname)).size!==2)throw Error('distinct RPCs required');
 const clients=urls.map(url=>v.createPublicClient({transport:v.http(url,{timeout:10000,retryCount:0})}));
 if((await Promise.all(clients.map(c=>c.getChainId()))).some(x=>x!==8453))throw Error('wrong chain');
 const heads=await Promise.all(clients.map(c=>c.getBlockNumber({cacheTime:0}))),blockNumber=heads.reduce((a,b)=>a<b?a:b)-2n;
 // Original-book keys are right-padded UTF-8 bytes32, per the reviewed activation.mjs keyOf; NOT keccak hashes.
 const abi=v.parseAbi(['function addr(bytes32) view returns(address)','function owner() view returns(address)']);
 const read=async c=>{const block=await c.getBlock({blockNumber});if(Math.abs(Date.now()/1000-Number(block.timestamp))>120)throw Error('stale block');
  const code=await c.getCode({address:BOOK,blockNumber});if(!code||v.keccak256(code)!=='0xe4f570e99f2ac708b35539fe5906889d8cb99189e6c9075f5e46d3b6921ac152')throw Error('original book code differs');const entries={};
  for(const key of ['sessionVaultFactory','secretVaultV2','deployments','registry'])entries[key]=(await c.readContract({address:BOOK,abi,functionName:'addr',args:[v.stringToHex(key,{size:32})],blockNumber})).toLowerCase();
  const owner=(await c.readContract({address:BOOK,abi,functionName:'owner',blockNumber})).toLowerCase();
  if((await c.getBlock({blockNumber})).hash!==block.hash)throw Error('reorg');return {blockNumber:String(blockNumber),blockHash:block.hash,blockTimestamp:Number(block.timestamp),book:BOOK,codeHash:v.keccak256(code),owner,entries};};
 const results=await Promise.all(clients.map(read));if(JSON.stringify(results[0])!==JSON.stringify(results[1]))throw Error('RPC disagreement');
 console.log(JSON.stringify({at:new Date().toISOString(),readOnly:true,providers:urls,...results[0],scope:'Current agreed-block book values, not an activation or policy migration proof.'},null,2));
}catch{console.error('Book observation unavailable or inconsistent; no activation inferred.');process.exitCode=1;}
