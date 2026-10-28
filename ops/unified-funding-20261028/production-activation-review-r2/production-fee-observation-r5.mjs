import {rpcClient} from './production-activation-prep-r1/capture-observation.mjs';
// Read-only observations; observed pins are NOT an approved activation manifest. No wallet or signing client.
import fs from 'node:fs';
import {encodeFunctionData,decodeFunctionResult,keccak256,parseAbi,toHex} from '../source/node_modules/viem/_esm/index.js';
import {createGasFundQuotePolicy,CONFIG_SCHEMA,FEED_ABI} from './fee-policy-r1/fee-policy.mjs';
const urls=['https://mainnet.base.org','https://base-mainnet.public.blastapi.io'];
const requests=urls.map(url=>{const rpc=rpcClient(url);return ({method,params})=>rpc(method,params);});
const out={at:new Date().toISOString(),readOnly:true,activation:false,providers:urls,signature:false};
try {
 const chains=await Promise.all(requests.map(r=>r({method:"eth_chainId",params:[]})));
 if(chains.some(x=>BigInt(x)!==8453n))throw Error("wrong chain");
 const heads=await Promise.all(requests.map(r=>r({method:'eth_blockNumber',params:[]})));
 const block=heads.map(BigInt).reduce((a,b)=>a<b?a:b)-2n;
 const headers=await Promise.all(requests.map(r=>r({method:'eth_getBlockByNumber',params:[toHex(block),false]})));
 if(headers[0].hash!==headers[1].hash)throw new Error('provider blockhash mismatch');
 const at={blockHash:headers[0].hash,requireCanonical:true};
 const oracle='0x420000000000000000000000000000000000000f',feed='0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70';
 const slot='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
 async function observe(r){const call=async(to,abi,functionName,args=[])=>decodeFunctionResult({abi,functionName,data:await r({method:'eth_call',params:[{to,data:encodeFunctionData({abi,functionName,args})},at]})});
 const implWord=await r({method:'eth_getStorageAt',params:[oracle,slot,at]});const impl='0x'+implWord.slice(-40);const agg=(await call(feed,FEED_ABI,'aggregator')).toLowerCase();
 const hashes={};for(const a of [oracle,impl,feed,agg]){const code=await r({method:'eth_getCode',params:[a,at]});if(code==='0x')throw new Error(`empty code ${a}`);hashes[a]=keccak256(code);}
 const decimals=await call(feed,FEED_ABI,'decimals'),description=await call(feed,FEED_ABI,'description');
 const seq='0xbcf85224fc0756b9fa45aa7892530b47e10b6433';
 const seqAgg=(await call(seq,FEED_ABI,'aggregator')).toLowerCase();
 const seqCodes=await Promise.all([seq,seqAgg].map(a=>r({method:'eth_getCode',params:[a,at]})));
 if(seqCodes.some(c=>c==='0x'))throw Error('empty sequencer code');
 const sequencer={address:seq,proxyCodehash:keccak256(seqCodes[0]),aggregator:seqAgg,aggregatorCodehash:keccak256(seqCodes[1]),graceSec:3600};
 const c={schema:CONFIG_SCHEMA,chainId:8453,notAfter:Math.floor(Date.now()/1000)+600,maxBlockAgeSec:120,quoteTtlSec:300,oracle:{address:oracle,proxyCodehash:hashes[oracle],implementation:impl,implementationCodehash:hashes[impl]},feed:{address:feed,proxyCodehash:hashes[feed],aggregator:agg,aggregatorCodehash:hashes[agg],decimals,description,maxAgeSec:3600,minAnswer:100n*10n**BigInt(decimals),maxAnswer:100000n*10n**BigInt(decimals)},sequencer,tx:{gasLimit:1000000,maxFeePerGas:20000000n,maxPriorityFeePerGas:2000000n,maxSignedBytes:720,maxAttempts:3,replacementBumpBps:2500},pricing:{marginBps:2000,maxFee6:80000n}};
 const p=createGasFundQuotePolicy({config:c,request:r});const q=await p.quote({phase:'quote',chainId:8453,block,vault:'0x2222222222222222222222222222222222222222',sid:'0x'+'5a'.repeat(32),deployment:'0x'+'d0'.repeat(32),ethOut:20000000000000n,feeTier:100,amountIn6:50000n,maxFee6:1000000n,envelopeEnforced:true});
 return{config:c,quote:q};}
 out.block=block;out.blockHash=headers[0].hash;out.results=[];
 for(const r of requests)out.results.push(await observe(r));
 const norm=o=>JSON.stringify(o,(_k,v)=>typeof v==='bigint'?v.toString():v);
 if(norm(out.results[0].quote.detail.components)!==norm(out.results[1].quote.detail.components))throw new Error('fee component mismatch');
 if(norm(out.results[0].quote.detail.price)!==norm(out.results[1].quote.detail.price))throw new Error('feed mismatch');
 out.agreed=true;
 out.limitations='Read-only fee observations using placeholder intent identities and configured one-million gas cap informed by successful historical Base fork call traces625399/609472/631198 gas; excludes intrinsic/cold-state differences and is not an actual signed production estimate. No actual signature/envelope estimate/send. Sequencer address verified against official Chainlink L2 Sequencer Uptime Feeds documentation (2026-10-28); 3600s grace checked. Configured gas cap is a bounded refusal ceiling, not measured real signed-call gas. Observed hashes are not approval.';
}catch(e){out.error=e.message;process.exitCode=1;}
fs.writeFileSync(new URL('./production-fee-observation-r5.json',import.meta.url),JSON.stringify(out,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({agreed:out.agreed,block:out.block?.toString(),error:out.error}));
