import fs from 'node:fs';
import {rpcClient} from '../production-activation-prep-r1/capture-observation.mjs';
import {createGasFundQuotePolicy} from '../fee-policy-r1/fee-policy.mjs';
const config=JSON.parse(fs.readFileSync(new URL('./fee-policy.json',import.meta.url)));
const urls=['https://base-rpc.publicnode.com','https://base-mainnet.public.blastapi.io'];
const out={at:new Date().toISOString(),readOnly:true,gasLimit:config.tx.gasLimit,feeCap:config.pricing.maxFee6,providers:urls};
try{
const rs=urls.map(u=>{const r=rpcClient(u);let tail=Promise.resolve();return({method,params})=>{const run=tail.then(async()=>{await new Promise(ok=>setTimeout(ok,3500));return r(method,params)});tail=run.catch(()=>{});return run}});
const chains=await Promise.all(rs.map(r=>r({method:'eth_chainId',params:[]})));if(chains.some(c=>BigInt(c)!==8453n))throw Error('wrongchain');
const ns=await Promise.all(rs.map(r=>r({method:'eth_blockNumber',params:[]})));const b=ns.map(BigInt).reduce((a,c)=>a<c?a:c)-2n;const q='0x'+b.toString(16);
const hs=await Promise.all(rs.map(r=>r({method:'eth_getBlockByNumber',params:[q,false]})));if(hs[0].hash!==hs[1].hash||hs.some(h=>BigInt(h.number)!==b))throw Error('header mismatch');
out.block=b.toString();out.blockHash=hs[0].hash;
out.results=await Promise.all(rs.map(async request=>{
 const p=createGasFundQuotePolicy({config,request});return p.quote({phase:'quote',chainId:8453,block:b,vault:'0x86960ED815ca5500E6CFcdBbb32b221C2acF055a',sid:'0x0e6374283afed13378259e0572b9a9e9e2830128c5197c3bcfdc6592248a4ed5',deployment:'0x'+'d0'.repeat(32),ethOut:200000000000000n,feeTier:100,amountIn6:465000n,maxFee6:80000n,envelopeEnforced:true});}));
const norm=o=>JSON.stringify(o,(_k,v)=>typeof v==='bigint'?v.toString():v);
if(norm(out.results[0].detail.components)!==norm(out.results[1].detail.components))throw Error('fee component mismatch');out.agreed=true;
}catch(e){out.error=e.message;process.exitCode=1;}
fs.writeFileSync(new URL('./observation-r3.json',import.meta.url),JSON.stringify(out,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n',{flag:'wx'});console.log(JSON.stringify({agreed:out.agreed,error:out.error,block:out.block,fees:out.results?.map(x=>String(x.fee6))}));
