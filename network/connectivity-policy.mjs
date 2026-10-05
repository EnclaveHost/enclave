import {keccak256,stringToHex} from 'viem';
import {verifyQualification} from './provider-qualification.mjs';

const uint=value=>typeof value==='string'&&/^(0|[1-9]\d{0,23})$/.test(value);
export function validateDirectPolicy(p) {
  if(!p||p.version!==3||!/^0x[0-9a-f]{64}$/.test(p.deploymentId||'')||p.mode!=='direct'||
    p.directFallback!==false||p.routes!==1||!uint(p.maxPricePerGiB6)||!uint(p.budget6)||!uint(p.nonce)||BigInt(p.nonce)===0n||
    !/^0x[0-9a-f]{40}$/.test(p.connectivity||'')||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=0||
    Object.keys(p).some(k=>!['version','deploymentId','mode','directFallback','routes','maxPricePerGiB6','budget6','nonce','connectivity','expiresAt'].includes(k)))
    throw new Error('invalid owner direct network policy');
  return {...p};
}
export function validateHostConnectivity(c) {
  if(!c||c.version!==1||typeof c.direct!=='boolean'||typeof c.tunaProvider!=='boolean'||
    Object.keys(c).some(k=>!['version','direct','tunaProvider','pricePerGiB6'].includes(k))||
    !uint(c.pricePerGiB6))throw new Error('invalid host connectivity capabilities');
  return {...c};
}
export async function hostConnectivity({config,qualification,...context}) {
  const c=validateHostConnectivity(config);
  let qualified=null,error=null;
  if(c.direct||c.tunaProvider) {
    try{qualified=await verifyQualification(qualification,context);}catch(e){error=e.message;}
  }
  return {compute:true,direct:c.direct&&!!qualified,tunaProvider:c.tunaProvider&&!!qualified,
    address:qualified?.address,pricePerGiB6:c.pricePerGiB6,qualifiedUntil:qualified?.expiresAt||0,error};
}
// payoutWallet comes from the wallet's on-chain declaration, not an operator-
// supplied setting. The caller must use the same fresh chain snapshot as the lease.
export function directTerms({policy,host,lease,payoutWallet,now=Date.now()}) {
  const p=validateDirectPolicy(policy);
  if(!host?.direct||host.qualifiedUntil<=now)throw new Error('qualified direct provider required');
  if(!lease?.active||lease.id!==p.deploymentId||lease.validUntil<=now)throw new Error('current deployment lease required');
  const c=lease.connectivity;
  if(!c||c.viaTuna||c.address!==p.connectivity||String(c.nonce)!==p.nonce||Number(c.expires)*1000!==p.expiresAt||
    p.expiresAt<=now||c.owner.toLowerCase()!==lease.owner.toLowerCase()||!c.direct||
    String(c.maxPricePerGiB6)!==p.maxPricePerGiB6||String(c.budget6)!==p.budget6||
    String(c.pricePerGiB6)!==host.pricePerGiB6||Number(c.qualifiedUntil)*1000<=now||
    c.operator.toLowerCase()!==lease.runnerOperator.toLowerCase()||c.addressHash!==keccak256(stringToHex(host.address)))
    throw new Error('current on-chain direct authorization required');
  const selfHosted=/^0x[0-9a-fA-F]{40}$/.test(payoutWallet||'')&&
    !/^0x0{40}$/i.test(payoutWallet)&&payoutWallet.toLowerCase()===lease.owner.toLowerCase();
  const price=selfHosted?0n:BigInt(host.pricePerGiB6);
  if(price>BigInt(p.maxPricePerGiB6))throw new Error('direct bandwidth price exceeds owner limit');
  if(!selfHosted&&price>0n&&BigInt(p.budget6)===0n)throw new Error('direct bandwidth budget required');
  return {transport:'direct',currency:'USDC',pricePerGiB6:price.toString(),budget6:p.budget6,selfHosted,
    providerBps:Number(c.providerBps),spent6:String(c.spent6),nonce:p.nonce,connectivity:p.connectivity,
    expiresAt:Math.min(host.qualifiedUntil,lease.validUntil,p.expiresAt,Number(c.qualifiedUntil)*1000)};
}
