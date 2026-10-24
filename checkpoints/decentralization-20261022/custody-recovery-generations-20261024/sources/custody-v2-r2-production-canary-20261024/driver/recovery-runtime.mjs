// Explicit generations only. No transaction submission, automatic retry, or lifecycle-pass recording.
import path from 'node:path';
import {canonical,sha256hex} from './canonical.mjs';
import {verifyLaunchBundle,stageRecoveryBundle,verifyRecoveryBundle,recoveryReference} from './launch-bundle.mjs';
import {startCanaryRuntime,inspectStoppedCanaryRuntime,linuxRuntimeIO} from './launch-runtime.mjs';
const need=(ok,m)=>{if(!ok)throw Error('canary recovery refused: '+m);};
const hash=v=>sha256hex(canonical(v));
export function generationOptions({pins,runLabel,digest}) {
 need(/^\d{8}T\d{6}Z$/.test(runLabel??'')&&runLabel>=pins.runLabel,'invalid generation');
 const parent=path.dirname(path.dirname(pins.custodian.captureDir));
 return {pins,runLabel,digest,bundle:path.join(parent,(runLabel===pins.runLabel?'r2-launch-':'r2-recovery-')+runLabel),runtimeDir:path.join(parent,'runtime-'+runLabel),
  verifyBundle:runLabel===pins.runLabel?verifyLaunchBundle:verifyRecoveryBundle};
}
function matchStopped(r,s) {
 need(s.status==='stopped-verified'&&s.processesAbsent===true&&s.portsAbsent===true&&s.protectedServicesUnchanged===true,'predecessor is not verified stopped');
 const v=Object.fromEntries(Object.keys(r.stopped).map(k=>[k,s[k]]));need(hash(v)===hash(r.stopped),'predecessor generation, boot or sealed state changed');
}
async function committee(readGenesis,committeeId) {
 const r=await readGenesis();need(r?.outcome==='pass'&&r.evidence?.deploymentId===committeeId&&r.evidence.seats===1&&r.evidence.threshold===1
  &&r.evidence.resolves?.['committee.verified']?.ok===true,'original confirmed genesis must be reconciled; never create a replacement committee');return r;
}
export async function prepareCanaryRecovery({pins,originDigest,previousLabel,previousDigest,generation,mode,committeeId,readGenesis,io=linuxRuntimeIO(),inspectStopped=inspectStoppedCanaryRuntime,stageBundle=stageRecoveryBundle}) {
 const previous=generationOptions({pins,runLabel:previousLabel,digest:previousDigest}),originBundle=path.dirname(pins.custodian.captureDir);
 const before=inspectStopped({...previous,io});await committee(readGenesis,committeeId);
 const after=inspectStopped({...previous,io});
 const recovery=recoveryReference({pins,originBundle,originDigest,previous:{bundle:previous.bundle,digest:previousDigest,runtimeDir:previous.runtimeDir,runLabel:previousLabel},generation,mode,committeeId,stopped:before});
 matchStopped(recovery,after);
 return stageBundle({pins,parent:path.dirname(originBundle),recovery});
}
export async function startCanaryRecovery({pins,runLabel,digest,readGenesis,readAuthority,io=linuxRuntimeIO(),verifyRecovery=verifyRecoveryBundle,inspectStopped=inspectStoppedCanaryRuntime,startRuntime=startCanaryRuntime}) {
 const options=generationOptions({pins,runLabel,digest});need(runLabel!==pins.runLabel,'fresh launch is not a recovery');
 let recovery;
 const guardedVerify=o=>{
  const v=verifyRecovery(o);need(v.runLabel===runLabel,'recovery package generation differs');
  if(recovery)need(hash(recovery)===hash(v.recovery),'recovery reference changed');recovery=v.recovery;
  if(o.requireFresh){const prev=generationOptions({pins,runLabel:recovery.previous.runLabel,digest:recovery.previous.digest});matchStopped(recovery,inspectStopped({...prev,io}));}
  return v;
 };
 guardedVerify({pins,bundle:options.bundle,expectedDigest:digest,requireFresh:true});
 return startRuntime({...options,io,verifyBundle:guardedVerify,readAuthority:async()=>{await committee(readGenesis,recovery.committeeId);return readAuthority();}});
}


// No lifecycle step is journaled here. A recipient still has to consume the current canary revision.
export async function verifyRecoveredCanary({committeeId,digest,verifyLaunch,verifyGenesis,inspectRuntime,now=()=>Date.now()}) {
 const began=now(),launch=await verifyLaunch();need(launch?.outcome==='pass'&&launch.evidence?.runtime?.bundleDigest===digest,'fresh local/public attestation and runtime verification required');
 const genesis=await committee(verifyGenesis,committeeId),g=genesis.evidence,q=launch.evidence.publicQuote;
 need(['identity','encKey','endpoint'].every(k=>g[k]===q?.[k])&&g.measurement===q.measurementSha256,'recovered SNP machine differs from the confirmed genesis');
 const after=await inspectRuntime(),prior=launch.evidence.runtime;
 need(after.status==='runtime-verified'&&['unit','invocation','bundleDigest','hostPid','guestPid'].every(k=>after[k]===prior[k]),'runtime changed while reconciling recovered identity');
 need(now()>=began&&now()-began<=120000,'recovery verification expired');
 return {status:'recovery-attested',runtime:after,attestation:launch.evidence,genesis:g,
  scope:'Recovered runtime/ingress and fresh SNP identity match the original canonical committee. No recipient release, outage-refusal, rollback-protection or decentralized-custody claim.'};
}
