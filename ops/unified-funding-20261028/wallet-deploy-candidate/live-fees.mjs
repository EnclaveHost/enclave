// Root review fix: fresh Base L1/operator observations at the exact agreed preflight block.
// Read-only. The reviewed L2 caps stay fixed; inclusion-time L1/operator drift is not bounded by this observation.
import {encodeFunctionData,decodeFunctionResult,keccak256} from 'viem';
import {ORACLE_ABI,eip1559Sizes,flzStrictUpperBound,oracleFlzUpperBound} from '../fee-policy-candidate/fee-policy.mjs';
const SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export async function readLiveFees({rpc,oracle,transactions,at}) {
 if(!oracle)throw Error('missing reviewed fee oracle pins');
 for(const [a,h] of [[oracle.address,oracle.proxyCodehash],[oracle.implementation,oracle.implementationCodehash]])
  if(keccak256(await rpc('eth_getCode',[a,at]))!==h)throw Error('fee oracle runtime changed');
 if(('0x'+(await rpc('eth_getStorageAt',[oracle.address,SLOT,at])).slice(-40)).toLowerCase()!==oracle.implementation.toLowerCase())throw Error('fee oracle implementation changed');
 const call=async functionName=>decodeFunctionResult({abi:ORACLE_ABI,functionName,data:await rpc('eth_call',[{to:oracle.address,data:encodeFunctionData({abi:ORACLE_ABI,functionName})},at])});
 if(!await call('isFjord')||!await call('isIsthmus'))throw Error('unsupported Base fee regime');
 const rows=[];
 for(const t of transactions){
  const sz=eip1559Sizes({chainId:8453n,nonce:BigInt(t.nonce),gas:t.gas,maxFeePerGas:t.maxFeePerGas,maxPriorityFeePerGas:t.maxPriorityFeePerGas,dataBytes:t.dataBytes,value:0n});
  if(sz.signedMax>65536)throw Error('deployment size bound');
  let arg=Math.max(0,sz.signedMax-68);while(oracleFlzUpperBound(arg)<flzStrictUpperBound(sz.signedMax))arg++;
  const fee=async(fn,args)=>decodeFunctionResult({abi:ORACLE_ABI,functionName:fn,data:await rpc('eth_call',[{to:oracle.address,data:encodeFunctionData({abi:ORACLE_ABI,functionName:fn,args})},at])});
  const l1=await fee('getL1FeeUpperBound',[BigInt(arg)]),operator=await fee('getOperatorFee',[t.gas]);
  rows.push({name:t.name,l1ObservedWei:l1,operatorObservedWei:operator,totalObservedWei:t.gas*t.maxFeePerGas+l1+operator});
 }
 return {rows,totalObservedWei:rows.reduce((sum,r)=>sum+r.totalObservedWei,0n)};
}
