import fs from 'node:fs';
import {createPublicClient,http,parseAbi,keccak256} from '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/viem/_esm/index.js';
const urls=['https://base-rpc.publicnode.com','https://base-mainnet.public.blastapi.io'];
const cs=urls.map(url=>createPublicClient({transport:http(url,{timeout:15000,retryCount:0})}));
const factory='0x33128a8fC17869897dcE68Ed026d694621f6FDfD',router='0x2626664c2603336E57B271c5C0b26F421741e481',quoter='0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',weth='0x4200000000000000000000000000000000000006',usdc='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const abi=parseAbi(['function factory() view returns(address)','function WETH9() view returns(address)','function getPool(address,address,uint24) view returns(address)','function token0() view returns(address)','function token1() view returns(address)','function fee() view returns(uint24)','function liquidity() view returns(uint128)','function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const heads=await Promise.all(cs.map(async c=>{if(await c.getChainId()!==8453)throw Error('chain');return c.getBlockNumber()}));
const blockNumber=heads.reduce((a,b)=>a<b?a:b)-5n;
const results=await Promise.all(cs.map(async c=>{
 const b=await c.getBlock({blockNumber});const read=(address,functionName,args=[])=>c.readContract({address,abi,functionName,args,blockNumber});
 if((await read(router,'factory')).toLowerCase()!==factory.toLowerCase()||(await read(router,'WETH9')).toLowerCase()!==weth.toLowerCase())throw Error('router bindings');
 const codeHashes={};for(const [name,address] of Object.entries({factory,router,quoter,weth,usdc})){const code=await c.getCode({address,blockNumber});if(!code||code==='0x')throw Error('code missing');codeHashes[name]=keccak256(code)}
 const pools=[];for(const fee of [100,500,3000]){
  const pool=await read(factory,'getPool',[usdc,weth,fee]);if(/^0x0{40}$/i.test(pool))continue;
  const [token0,token1,actualFee,liquidity]=await Promise.all(['token0','token1','fee','liquidity'].map(n=>read(pool,n)));
  if(actualFee!==fee||![token0.toLowerCase(),token1.toLowerCase()].includes(usdc.toLowerCase())||![token0.toLowerCase(),token1.toLowerCase()].includes(weth.toLowerCase()))throw Error('pool bindings');
  const q=await c.simulateContract({address:quoter,abi,functionName:'quoteExactOutputSingle',args:[{tokenIn:usdc,tokenOut:weth,amount:20000000000000n,fee,sqrtPriceLimitX96:0n}],blockNumber});
  pools.push({pool,fee,liquidity,ethOut:20000000000000n,usdcIn6:q.result[0],gasEstimate:q.result[3]});
 }
 return {blockNumber,blockHash:b.hash,timestamp:b.timestamp,codeHashes,pools};
}));
const str=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2);
if(str(results[0])!==str(results[1]))throw Error('provider disagreement');
const out={at:new Date().toISOString(),source:'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments',addresses:{factory,router,quoter,weth,usdc},providers:urls,...results[0],transactionsSent:0};
fs.writeFileSync(new URL('./dex-live-20261028.json',import.meta.url),str(out)+'\n',{flag:'wx'});console.log(str(out));
