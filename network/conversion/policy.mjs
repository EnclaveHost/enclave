// Provider-owned currency management. This module never reads or debits an app
// ledger, and a conversion is never a bandwidth revenue event.
export const ASSETS=Object.freeze({
 USDC:Object.freeze({id:'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bdA02913'.toLowerCase(),decimals:6}),
 NKN:Object.freeze({id:'nkn:mainnet/native',decimals:8}),
});
export function units(value,{zero=true}={}){
 if(typeof value!=='string'||!(/^(0|[1-9]\d{0,37})$/).test(value)||(!zero&&value==='0'))throw Error('invalid exact amount');
 return BigInt(value);
}
export function decimalUnits(value,decimals){
 if(typeof value!=='string'||!new RegExp(`^(0|[1-9]\\d{0,20})(\\.\\d{1,${decimals}})?$`).test(value))throw Error('invalid decimal amount');
 const [whole,fraction='']=value.split('.');return units((whole+fraction.padEnd(decimals,'0')).replace(/^0+(?=\d)/,''));
}
export function validatePolicy(p){
 if(!p||p.version!==1||!['USDC','NKN'].includes(p.payoutCurrency)||typeof p.allowExternal!=='boolean')throw Error('invalid currency policy');
 for(const k of ['reserveNkn8','refillBelowNkn8','buyUsdc6','maxConversionUsdc6','dailyConversionUsdc6','maxSellNkn8','minNknPerUsdc8','minUsdcPerNkn6'])units(p[k]);
 if(units(p.refillBelowNkn8)>=units(p.reserveNkn8)||units(p.buyUsdc6,{zero:false})>units(p.maxConversionUsdc6)||units(p.maxConversionUsdc6,{zero:false})>units(p.dailyConversionUsdc6))throw Error('invalid conversion limits');
 if(!Number.isInteger(p.maxSlippageBps)||p.maxSlippageBps<0||p.maxSlippageBps>1000||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=0)throw Error('invalid conversion bounds');
 units(p.minNknPerUsdc8,{zero:false});units(p.minUsdcPerNkn6,{zero:false});units(p.maxSellNkn8,{zero:false});
 return Object.freeze({...p});
}
export function conversionIntent(policy,{usdc6,nkn8},now=Date.now()){
 const p=validatePolicy(policy);if(now>=p.expiresAt)return null;
 const usdc=units(usdc6),nkn=units(nkn8);
 if(nkn<units(p.refillBelowNkn8)&&usdc>=units(p.buyUsdc6))return {direction:'USDC_TO_NKN',amount: p.buyUsdc6};
 if(p.payoutCurrency==='USDC'&&nkn>units(p.reserveNkn8)){
  const spare=nkn-units(p.reserveNkn8),cap=units(p.maxSellNkn8);return {direction:'NKN_TO_USDC',amount:String(spare<cap?spare:cap)};
 }
 // Selecting NKN payout converts the operator's available USDC, never customer credit.
 if(p.payoutCurrency==='NKN'&&usdc>=units(p.buyUsdc6))return {direction:'USDC_TO_NKN',amount:p.buyUsdc6};
 return null;
}
export function validateQuote(q,{policy,intent,addresses,now=Date.now()}){
 const p=validatePolicy(policy),buy=intent.direction==='USDC_TO_NKN';
 if(!buy&&intent.direction!=='NKN_TO_USDC')throw Error('invalid conversion direction');
 const input=buy?'USDC':'NKN',output=buy?'NKN':'USDC';
 if(!q||q.inputAsset!==ASSETS[input].id||q.outputAsset!==ASSETS[output].id||q.amountIn!==intent.amount||q.recipient!==addresses[output]||q.refundAddress!==addresses[input])throw Error('quote differs from authorized conversion');
 if(!['atomic','external'].includes(q.custody)||(q.custody==='external'&&!p.allowExternal))throw Error('conversion trust policy mismatch');
 if(typeof q.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(q.id)||!Number.isSafeInteger(q.expiresAt)||q.expiresAt<=now+10000||q.expiresAt>now+120000||now>=p.expiresAt)throw Error('quote expired or invalid');
 const amount=units(q.amountIn,{zero:false}),expected=units(q.expectedOut,{zero:false}),minimum=units(q.minimumOut,{zero:false});
 // A price estimate is not an enforceable minimum. Do not silently downgrade
 // automatic conversion to an unbounded floating-rate deposit.
 if(q.minimumEnforced!==true||minimum>expected||minimum*10000n<expected*BigInt(10000-p.maxSlippageBps))throw Error('minimum output is not protected');
 const cost=buy?units(q.allInUsdc6,{zero:false}):expected;
 if(cost>units(p.maxConversionUsdc6))throw Error('conversion exceeds per-order USDC limit');
 if(buy&&(cost<amount||minimum*1000000n<cost*units(p.minNknPerUsdc8)))throw Error('conversion exceeds accepted price');
 if(!buy&&minimum*100000000n<amount*units(p.minUsdcPerNkn6))throw Error('conversion exceeds accepted price');
 return {input,output,cost:String(cost)};
}
