// READ ONLY preparation. No signing client or mutable RPC methods. Not a production fee guarantee/approval.
import fs from 'node:fs';
import {encodeFunctionData,decodeFunctionResult,keccak256,toHex,serializeTransaction} from 'viem';
import {ORACLE_ABI,FEED_ABI,eip1559Sizes,flzStrictUpperBound,oracleFlzUpperBound,usdc6For} from '../fee-policy-candidate/fee-policy.mjs';
const proposal=JSON.parse(fs.readFileSync(new URL('./UNSIGNED-PROPOSAL-r1.json',import.meta.url)));
const replay=JSON.parse(fs.readFileSync(new URL('./FORK-REPLAY-r2.json',import.meta.url)));
const pins=JSON.parse(fs.readFileSync(new URL('../fee-policy-candidate/BASE-OBSERVATION-r1.json',import.meta.url))).results[0].config;
const urls=['https://base-rpc.publicnode.com','https://base-mainnet.public.blastapi.io'];
const ALLOW=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_getStorageAt','eth_call','eth_getTransactionCount','eth_getBalance']);
const lastRequest=new Map();
const request=url=>async(method,params=[])=>{if(!ALLOW.has(method))throw Error('read-only RPC');await new Promise(resolve=>setTimeout(resolve,Math.max(0,1500-(Date.now()-(lastRequest.get(url)||0)))));lastRequest.set(url,Date.now());const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error(`HTTP${r.status}`);const j=await r.json();if(j.error)throw Error(`${method}: ${j.error.message}`);return j.result;};
const rs=urls.map(request),out={at:new Date().toISOString(),readOnly:true,signable:false,nonceReserved:false,production:false,providers:urls};
const stringify=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?String(v):v,2);
try{
 const heads=await Promise.all(rs.map(async r=>{if(BigInt(await r('eth_chainId'))!==8453n)throw Error('chain');return BigInt(await r('eth_blockNumber'));}));
 const block=heads.reduce((a,b)=>a<b?a:b)-2n; const headers=await Promise.all(rs.map(r=>r('eth_getBlockByNumber',[toHex(block),false])));
 if(headers[0].hash!==headers[1].hash)throw Error('block disagreement');
 const at={blockHash:headers[0].hash,requireCanonical:true};out.block=block;out.blockHash=at.blockHash;
 out.results=[];
 for(const r of rs){
  const call=async(address,abi,functionName,args=[])=>decodeFunctionResult({abi,functionName,data:await r('eth_call',[{to:address,data:encodeFunctionData({abi,functionName,args})},at])});
  for(const [a,h] of [[pins.oracle.address,pins.oracle.proxyCodehash],[pins.oracle.implementation,pins.oracle.implementationCodehash],[pins.feed.address,pins.feed.proxyCodehash],[pins.feed.aggregator,pins.feed.aggregatorCodehash]])if(keccak256(await r('eth_getCode',[a,at]))!==h)throw Error('dependency code drift');
  const slot='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  if(('0x'+(await r('eth_getStorageAt',[pins.oracle.address,slot,at])).slice(-40)).toLowerCase()!==pins.oracle.implementation.toLowerCase())throw Error('oracle implementation drift');
  if((await call(pins.feed.address,FEED_ABI,'aggregator')).toLowerCase()!==pins.feed.aggregator.toLowerCase())throw Error('feed aggregator drift');
  const dec=await call(pins.feed.address,FEED_ABI,'decimals'),round=await call(pins.feed.address,FEED_ABI,'latestRoundData');
  if(Number(dec)!==Number(pins.feed.decimals)||round[1]<=0n||round[3]===0n||round[3]>BigInt(headers[0].timestamp)||BigInt(headers[0].timestamp)-round[3]>3600n||round[4]<round[0])throw Error('feed invalid/stale');
  if(!await call(pins.oracle.address,ORACLE_ABI,'isFjord')||!await call(pins.oracle.address,ORACLE_ABI,'isIsthmus'))throw Error('unsupported fee regime');
  const nonce=BigInt(await r('eth_getTransactionCount',[proposal.deployer,'latest'])),pending=BigInt(await r('eth_getTransactionCount',[proposal.deployer,'pending']));
  if(nonce!==pending||nonce!==BigInt(proposal.observedNonce))throw Error('owner nonce changed; regenerate deployment bundle');
  const balance=BigInt(await r('eth_getBalance',[proposal.deployer,at]));let total=0n;const rows=[];
  for(let i=0;i<proposal.transactions.length;i++){
   const t=proposal.transactions[i],q=replay.transactions[i];if(q.name!==t.name||q.nonce!==t.nonce||keccak256(t.data)!==t.dataHash)throw Error('proposal/replay mismatch');
   const gas=BigInt(q.gasLimit),maxFeePerGas=20_000_000n,maxPriorityFeePerGas=2_000_000n;
   if(BigInt(headers[0].baseFeePerGas)+maxPriorityFeePerGas>maxFeePerGas)throw Error('L2 cap insufficient');
   const sizes=eip1559Sizes({chainId:8453n,nonce:BigInt(t.nonce),maxFeePerGas,maxPriorityFeePerGas,gas,dataBytes:(t.data.length-2)/2,value:0n});
   const encoded=serializeTransaction({type:'eip1559',chainId:8453,nonce:Number(t.nonce),gas,maxFeePerGas,maxPriorityFeePerGas,data:t.data,value:0n},{r:'0x'+'ff'.repeat(32),s:'0x'+'ff'.repeat(32),yParity:1});
   if(sizes.signedMax<(encoded.length-2)/2||sizes.signedMax>65536)throw Error('creation size bound');
   // Creation uses a 0-byte destination: helper's 20-byte destination intentionally overestimates it.
   let arg=Math.max(0,sizes.signedMax-68);while(oracleFlzUpperBound(arg)<flzStrictUpperBound(sizes.signedMax))arg++;
   const l1=await call(pins.oracle.address,ORACLE_ABI,'getL1FeeUpperBound',[BigInt(arg)]),operator=await call(pins.oracle.address,ORACLE_ABI,'getOperatorFee',[gas]);
   const l2=gas*maxFeePerGas,cost=l2+l1+operator;total+=cost;rows.push({name:t.name,gas,maxFeePerGas,maxPriorityFeePerGas,signedSizeBound:sizes.signedMax,l1Argument:arg,l2CapWei:l2,l1ObservedUpperWei:l1,operatorObservedWei:operator,totalObservedBoundWei:cost});
  }
  out.results.push({nonce,pending,balance,rows,totalObservedBoundWei:total,usd6AtObservedFeed:usdc6For(total,round[1],BigInt(dec)),ownerBalanceCoversObservation:balance>=total,feed:{answer:round[1],decimals:dec,updatedAt:round[3]}});
 }
 if(stringify(out.results[0])!==stringify(out.results[1]))throw Error('provider result disagreement');out.agreed=true;
 out.limitations='L2 gas limits/caps derived from successful fork. L1/operator/ETHUSD are pinned observations, not inclusion-time guarantees. Recheck immediately before each signature; owner nonce is not reserved. Test signature encodings are size fixtures only. No wallet funding request or session charge.';
}catch(e){out.error=e.message;process.exitCode=1;}
fs.writeFileSync(new URL('./COST-OBSERVATION-r3.json',import.meta.url),stringify(out)+'\n',{flag:'wx'});console.log(stringify({agreed:out.agreed,block:out.block,error:out.error,total:out.results?.[0]?.totalObservedBoundWei,usd6:out.results?.[0]?.usd6AtObservedFeed}));
