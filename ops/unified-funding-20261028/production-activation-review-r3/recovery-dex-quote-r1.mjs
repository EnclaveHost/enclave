import fs from 'node:fs';
import {parseAbi,encodeFunctionData,decodeFunctionResult,toHex,keccak256} from '../source/node_modules/viem/_esm/index.js';
import {rpcClient} from './production-activation-prep-r1/capture-observation.mjs';
const input=JSON.parse(fs.readFileSync('/home/steven/Documents/Codex/2026-10-23/it/work/restore-queued-20261028/recovery-proposal-buffer200.json','utf8'));
if(input.apps.length!==10 || new Set(input.apps.map(x=>x.id)).size!==10)throw Error('unexpected recovery scope');
const abi=parseAbi(['function factory() view returns(address)','function WETH9() view returns(address)','function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const Q='0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',WETH='0x4200000000000000000000000000000000000006',FACTORY='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const urls=['https://mainnet.base.org','https://base-mainnet.public.blastapi.io'],r=urls.map(x=>rpcClient(x));
const out={at:new Date().toISOString(),readOnly:true,signed:false,broadcast:false,grantApproved:false,providers:urls,sourceReserveBlock:input.reserveBlock};
try{
 const chains=await Promise.all(r.map(x=>x('eth_chainId',[])));if(chains.some(x=>BigInt(x)!==8453n))throw Error('wrong chain');
 const tips=await Promise.all(r.map(x=>x('eth_blockNumber',[])));const n=tips.map(BigInt).reduce((a,b)=>a<b?a:b)-2n;
 const heads=await Promise.all(r.map(x=>x('eth_getBlockByNumber',[toHex(n),false])));
 if(heads.some(x=>BigInt(x.number)!==n||x.hash!==heads[0].hash))throw Error('header disagreement');out.block=n;out.blockHash=heads[0].hash;
 const at={blockHash:out.blockHash,requireCanonical:true};
 out.results=await Promise.all(r.map(async rpc=>{
  const call=async(fn,args=[])=>decodeFunctionResult({abi,functionName:fn,data:await rpc('eth_call',[{to:Q,data:encodeFunctionData({abi,functionName:fn,args})},at])});
  const code=await rpc('eth_getCode',[Q,at]);if(code==='0x')throw Error('quoter absent');
  if((await call('factory')).toLowerCase()!==FACTORY.toLowerCase()||(await call('WETH9')).toLowerCase()!==WETH.toLowerCase())throw Error('quoter binding mismatch');
  const apps=[];
  for(const app of input.apps){
   const amount=BigInt(app.proposedTopUpWei);if(amount<=0n||amount>200000000000000n)throw Error('target out of bounds');
   const tiers=[];
   for(const fee of [100,500,3000]){
    const q=await call('quoteExactOutputSingle',[{tokenIn:USDC,tokenOut:WETH,amount,fee,sqrtPriceLimitX96:0n}]);
    tiers.push({fee,amountIn6:q[0],quoterGasEstimate:q[3]});
   }
   tiers.sort((a,b)=>a.amountIn6<b.amountIn6?-1:a.amountIn6>b.amountIn6?1:0);
   const best=tiers[0];const maxUsdcIn6=(best.amountIn6*10100n+9999n)/10000n;
   apps.push({id:app.id,host:app.host,appRef:app.appRef,ethOut:amount,tiers,chosenTier:best.fee,maxUsdcIn6,withMaxFee6:maxUsdcIn6+80000n});
  }
  return{quoter:Q,quoterCodehash:keccak256(code),apps};
 }));
 const norm=v=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x);
 if(norm(out.results[0])!==norm(out.results[1]))throw Error('provider quote mismatch');
 out.agreed=true;
 out.groups=['NucBox','Metal0'].map(host=>({host,maxTotal6:out.results[0].apps.filter(x=>x.host===host).reduce((s,x)=>s+x.withMaxFee6,0n)}));
 out.limitations='Unsigned point-in-time DEX simulation only. Each app quote independent against same block, not a sequence simulation; actual grant/runtime checks and fresh per-execution quote required. 100bps max input plus80000microUSDC configured fee ceiling; does not choose/approve owner grants or a budget split. Source reserve balances must refresh before funding. Quoter internal gasEstimate is NOT session transaction gas.';
}catch(e){out.error=e.message;process.exitCode=1;}
fs.writeFileSync(new URL('./recovery-dex-quote-r1.json',import.meta.url),JSON.stringify(out,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n',{flag:'wx'});console.log(JSON.stringify({agreed:out.agreed,error:out.error,block:out.block?.toString()}));
