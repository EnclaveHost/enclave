// Metadata-only rejection test after C3 migrates. It deliberately provides no valid recipient attestation or operator signature.
import {OLD_COMMITTEE_4774,OLD_CUSTODIAN_ENDPOINT,PROTECTED_POLICY_4E62,METAL0_ENDPOINT,AGENT_EOA_29479} from './plan.mjs';
import {challenge,custodyPost,releaseBody} from './probe.mjs';
import {canonical,sha256hex} from './canonical.mjs';
const LOCAL=Symbol('old-committee-probe');
const need=(v,m)=>{if(!v)throw Object.assign(Error('old committee probe refused: '+m),{[LOCAL]:true});};
const binarySafe=v=>v instanceof Uint8Array?{bytes:Buffer.from(v).toString('hex')}:Array.isArray(v)?v.map(binarySafe):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,binarySafe(x)])):v;
const hash=v=>sha256hex(canonical(binarySafe(v)));
export async function probeOldCommittee({id,newCommittee,reader,fetchImpl=fetch,now=()=>Date.now()}) {
 try {
  need(/^0x[0-9a-f]{64}$/.test(id??'')&&id!==PROTECTED_POLICY_4E62,'dedicated canary deployment required');
  need(/^0x[0-9a-f]{64}$/.test(newCommittee??'')&&newCommittee!==OLD_COMMITTEE_4774,'new learned committee required');
  const started=now();
  const read=async()=>{
   const s=await reader.readRelease({id,endpoint:METAL0_ENDPOINT});
   need(Number.isSafeInteger(s.blockTimestamp)&&s.blockTimestamp>=now()/1000-120&&s.blockTimestamp<=now()/1000+10&&typeof s.blockNumber==='bigint'&&/^0x[0-9a-f]{64}$/.test(s.blockHash??''),'fresh agreed policy snapshot required');
   need(s.beneficialOwner===AGENT_EOA_29479&&s.policy?.owner===AGENT_EOA_29479&&s.policy.paused===false&&s.policy.committeeId===newCommittee&&s.policy.policyRev===2n&&s.policy.secretRev===2n
    &&s.bundle?.committeeId===newCommittee&&s.bundle.secretRev===2n&&s.bundle.data instanceof Uint8Array&&s.bundle.data.length>0,'C3 must already be at the new committee and exact second revision');
   return {blockNumber:String(s.blockNumber),blockHash:s.blockHash,blockTimestamp:s.blockTimestamp,policyRev:'2',secretRev:'2',committeeId:newCommittee,bundleSha256:sha256hex(s.bundle.data)};
  };
  const before=await read(),old=await reader.readCommittee({committeeId:OLD_COMMITTEE_4774});
  need(old.committee?.epoch===1&&old.committee.machines?.length===1&&/^0x[0-9a-f]{64}$/.test(old.committee.machines[0].encKey??''),'original single-seat committee unavailable');
  const oldKey=old.committee.machines[0].encKey,c=await challenge(fetchImpl,OLD_CUSTODIAN_ENDPOINT);
  need(c.encKey===oldKey&&c.expiresAt>now()/1000&&c.expiresAt<=now()/1000+125,'challenge is not from the expected old committee key or is stale');
  const body=releaseBody({id,endpoint:METAL0_ENDPOINT,committeeId:OLD_COMMITTEE_4774,epoch:1,policyRev:2n,secretRev:2n,challenge:c,nowSec:Math.floor(now()/1000)});
  const reply=await custodyPost(fetchImpl,OLD_CUSTODIAN_ENDPOINT,'/v2/custody/release',body);
  need(reply.status===409&&reply.body.error==='wrong_committee'&&Object.keys(reply.body).every(k=>k==='error'||k==='message')&&(reply.body.message===undefined||typeof reply.body.message==='string'),'old endpoint did not return an exact metadata-only wrong_committee refusal');
  const after=await read(),oldAfter=await reader.readCommittee({committeeId:OLD_COMMITTEE_4774});
  need(hash(oldAfter.committee)===hash(old.committee),'old committee changed during probe');
  for(const k of ['policyRev','secretRev','committeeId','bundleSha256'])need(before[k]===after[k],'migration state changed during probe');
  need(now()>=started&&now()-started<=120000,'probe collection expired');
  return {outcome:'pass',evidence:{id,oldEndpoint:OLD_CUSTODIAN_ENDPOINT,oldCommittee:OLD_COMMITTEE_4774,newCommittee,oldEncKey:oldKey,before,after,status:409,code:'wrong_committee',noPartial:true,
   scope:'Pre-attestation HTTP refusal for the migrated canary at the old endpoint. This does not prove a fully authorized recipient rejection, hardware-bound response authenticity, ciphertext erasure or sealed-state rollback protection.'}};
 }catch(e){if(e?.[LOCAL])throw e;throw Error('old committee probe refused: live evidence collection failed');}
}
