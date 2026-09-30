import {keccak256, stringToHex, recoverTypedDataAddress} from 'viem';
export const RECEIPT_TYPES={Receipt:[{name:'payloadHash',type:'bytes32'}]};
export function canonical(value) {
  if(value===null || typeof value==='boolean' || typeof value==='string') return JSON.stringify(value);
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype)
    return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  throw new Error('signed evidence uses strings, booleans, arrays and plain objects; numeric fields are decimal strings');
}
export function receiptData(payload,{chainId,contract}) {
  return {domain:{name:'EnclaveCapacityEvidence',version:'1',chainId,verifyingContract:contract},
    types:RECEIPT_TYPES,primaryType:'Receipt',message:{payloadHash:keccak256(stringToHex(canonical(payload)))}};
}
export async function verifyReceipt(envelope,{chainId,contract,signers,quorum,nowSec,kind,hostOperator}) {
  if(!Number.isInteger(quorum)||quorum<2) throw new Error('at least two independent witness groups required');
  if(!/^0x[0-9a-fA-F]{40}$/.test(hostOperator||''))throw new Error('host operator required');
  const hostGroup=signers[hostOperator.toLowerCase()];
  const payload=envelope?.payload;
  if(!payload || payload.kind!==kind || !/^\d+$/.test(payload.issuedSec||'')
    || !/^\d+$/.test(payload.expiresSec||'')) throw new Error('invalid receipt');
  if(BigInt(payload.issuedSec)>nowSec || BigInt(payload.expiresSec)<=nowSec) throw new Error('stale receipt');
  const groups=new Set(),addresses=new Set();
  const data=receiptData(payload,{chainId,contract});
  for(const signature of envelope.signatures||[]) {
    const address=(await recoverTypedDataAddress({...data,signature})).toLowerCase();
    const group=signers[address];
    if(!group || address===hostOperator?.toLowerCase() || (hostGroup && group===hostGroup) || addresses.has(address)) continue;
    addresses.add(address);groups.add(group);
  }
  if(groups.size<quorum) throw new Error('insufficient independent witness signatures');
  return payload;
}
