// Read-only discovery. SWFT's current deposit API is an external exchange;
// listing an asset or an indicative price is not an executable protected quote.
const ENDPOINT='https://www.swftc.info/gt/swap/v1/queryCoinList';
const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export function classifyAssets(data){
 if(!Array.isArray(data))throw Error('invalid asset list');
 const usdc=data.find(x=>x.coinCode==='USDC(BASE)'&&x.mainNetwork==='BASE'&&x.contact?.toLowerCase()===USDC&&Number(x.coinDecimal)===6);
 const nkn=data.find(x=>x.coinCode==='NKN'&&x.mainNetwork==='NKN'&&!x.contact&&Number(x.coinDecimal)===8);
 return {baseUSDC:!!usdc,nativeNKN:!!nkn};
}
export async function discoverConversion({fetcher=fetch}={}){
 const response=await fetcher(ENDPOINT,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({sourceType:'H5',userNo:'',sessionUuid:'',orderId:''}),signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('conversion discovery unavailable');
 const raw=await response.text();if(raw.length>2000000)throw Error('asset response too large');
 const data=JSON.parse(raw);if(String(data.resCode)!=='800')throw Error('conversion discovery failed');
 const assets=classifyAssets(data.data);
 return {provider:'SWFT',custody:'external',...assets,executable:false,
  reason:!assets.baseUSDC||!assets.nativeNKN?'native_pair_unavailable':'protected_native_quote_unverified',
  directions:['USDC_TO_NKN','NKN_TO_USDC']};
}
