import {verifyReceipt} from './evidence.mjs';
import {collectLedgerWindow} from './chain-observation.mjs';
import {observeMarket} from './accounting.mjs';
const integer=(v,name)=>{if(typeof v!=='string'||!/^\d{1,30}$/.test(v))throw new Error('invalid '+name);return BigInt(v);};
const hex=(v,n)=>typeof v==='string'&&new RegExp('^0x[0-9a-fA-F]{'+n+'}$').test(v);
/** Connect finalized demand to quorum-signed capacity. Signer groups and the
 * deployment-bound receipt domain are payer configuration, not values learned
 * from a host. This is an explicit peer trust model, not Sybil-proof consensus.
 */
export function createObservationLoader({chain,loadReceipts,resolveHost,trust,limits,now=()=>BigInt(Math.floor(Date.now()/1000))}) {
 return async()=>{
  const time=now(),window=await collectLedgerWindow(chain),capacities=[];
  const envelopes=await loadReceipts();if(!Array.isArray(envelopes)||envelopes.length>limits.maxReceipts)throw new Error('receipt limit exceeded');
  for(const envelope of envelopes) {
   const candidate=envelope?.payload;
   if(!hex(candidate?.hostId,64))throw new Error('invalid host identity');
   const host=await resolveHost(candidate.hostId,{blockNumber:window.checkpoint.blockNumber});
   if(!host?.active)continue;
   const p=await verifyReceipt(envelope,{...trust,nowSec:time,kind:'capacity',hostOperator:host.operator});
   if(p.classId!==chain.classId||p.operator?.toLowerCase()!==host.operator.toLowerCase()
    ||p.payoutWallet?.toLowerCase()!==host.payoutWallet.toLowerCase())throw new Error('receipt registry mismatch');
   if(!hex(p.hardwareId,64))throw new Error('hardware identity required');
   const c={...p,hostId:p.hostId.toLowerCase(),operator:host.operator.toLowerCase(),payoutWallet:host.payoutWallet.toLowerCase(),hardwareId:p.hardwareId.toLowerCase()};
   for(const k of ['issuedSec','expiresSec','units','spareUnits','minimumRate6'])c[k]=integer(p[k],k);
   // Capacity qualification may outlive a short pricing epoch, but current
   // spare allocation must have a separate fresh signed observation timestamp.
   const spareAt=integer(p.spareAtSec,'spareAtSec');
   if(spareAt>time||time-spareAt>limits.maxSpareAgeSec||c.units>limits.maxUnitsPerHost)continue;
   capacities.push(c);
  }
  return {...observeMarket({...window,nowSec:window.atSec,capacities,...limits}),checkpoint:window.checkpoint,trustMode:trust.trustMode||"independent"};
 };
}
