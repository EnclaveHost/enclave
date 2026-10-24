// One read-only launch gate. Inputs are live readers wired by CLI, never user observation JSON.
// Private quote/machine material stays in memory; only curated verifier evidence reaches the journal.
import {canonical,sha256hex} from './canonical.mjs';
import {MAX_QUOTE_AGE_MS} from './attestation.mjs';
import {R2,METAL0_REGISTRY_ID} from './plan.mjs';
import {REFUSAL_PROBES,INGRESS_SOURCE} from './launch-ingress.mjs';
const LOCAL=Symbol('launch-verify-local');
const need=(ok,m)=>{if(!ok)throw Object.assign(Error('canary launch verification refused: '+m),{[LOCAL]:true});};
const hash=v=>sha256hex(canonical(v));
const fields=['identity','encKey','endpoint','chipId','registryId','measurement'];
export function loopbackEvidenceTransport({endpoint,port,fetchImpl=fetch}) {
 const u=new URL(endpoint);need(u.protocol==='https:'&&u.origin===endpoint&&!u.username&&!u.password,'exact public origin required');
 need(Number.isSafeInteger(port)&&port>=1024&&port<=65535,'management port invalid');
 return async(url,options)=>{
  need(url===endpoint+'/v2/custody/evidence'&&options?.method==='POST'&&options.redirect==='error','only evidence POST can use the management socket');
  // The quote still binds the configured PUBLIC origin; only transport uses the runtime-verified local socket.
  return fetchImpl(`http://127.0.0.1:${port}/v2/custody/evidence`,{...options,redirect:'error'});
 };
}
export async function verifyLaunch({pins,digest,inspectRuntime,inspectIngress,readHost,attestLocal,attestPublic,now=()=>Date.now()}) {
 try {
  const started=now();need(Number.isSafeInteger(started),'local clock invalid');need(/^[a-f0-9]{64}$/.test(digest??''),'package digest required');
  const fresh=(at,max)=>Number.isSafeInteger(at)&&at<=now()&&now()-at<=max;
  const runtime=async()=>{const r=await inspectRuntime();need(r.status==='runtime-verified'&&r.bundleDigest===digest&&r.protectedServicesUnchanged===true&&r.loopbackPortsVerified===true
   &&r.memoryMaxMiB===5120&&r.memorySwapMaxMiB===0&&r.recipientReserveMiB===2048&&r.memAvailableMiB>=18432&&r.protectedVmCount>=3&&fresh(r.at,30000),'runtime or protected-resource evidence invalid');return r;};
  const ingress=async()=>{const r=await inspectIngress();need(r.endpoint===pins.custodian.endpoint&&/^[0-9a-f]{64}$/.test(r.bindingDigest??'')&&fresh(r.at,30000)&&Array.isArray(r.refusals)&&r.sourceCommit===INGRESS_SOURCE.commit&&hash(r.refusals)===hash(REFUSAL_PROBES.map(([method,path])=>({method,path,status:404}))),'live ingress evidence invalid');return r;};
  const authority=async()=>{const r=await readHost();need(r.outcome==='pass'&&r.evidence?.resolves?.['host.accepted']?.ok===true&&Number.isSafeInteger(r.evidence.blockTimestamp)
   &&r.evidence.blockTimestamp<=now()/1000+10&&r.evidence.blockTimestamp>=now()/1000-120,'accepted host authority unavailable or stale');return r.evidence;};
  const before=await runtime(),routingBefore=await ingress(),hostBefore=await authority();
  const local=await attestLocal(),publicQuote=await attestPublic();
  const quoteFresh=q=>{
   need(Number.isSafeInteger(q?.requestedAt)&&Number.isSafeInteger(q?.verifiedAt)&&q.verifiedAt>=q.requestedAt&&fresh(q.verifiedAt,MAX_QUOTE_AGE_MS)&&now()-q.requestedAt<=MAX_QUOTE_AGE_MS,'quote expired');
   const e=q.publicEvidence,m=q.machine;need(e?.vcekVerified===true&&e.minimumTcbChecked===true&&e.vmpl===0&&e.debugAllowed===false&&e.migrationAgentAllowed===false
    &&e.manifestSha256===R2.manifestSha256&&e.measurement===R2.measurement&&e.measurementSha256===R2.measurementSha256
    &&/^0x[0-9a-f]{40}$/.test(m?.identity??'')&&['encKey','chipId'].every(k=>/^0x[0-9a-f]{64}$/.test(m?.[k]??''))&&e.identity===m.identity&&e.encKey===m.encKey&&e.endpoint===m.endpoint
    &&m?.endpoint===pins.custodian.endpoint&&m.registryId===METAL0_REGISTRY_ID&&m.measurement===R2.measurementSha256,'reviewed SNP machine evidence missing');
  };
  quoteFresh(local);quoteFresh(publicQuote);
  need(fields.every(k=>local.machine[k]===publicQuote.machine[k]),'public route does not serve the locally attested machine');
  need(/^[a-f0-9]{64}$/.test(local.publicEvidence.challengeSha256)&&/^[a-f0-9]{64}$/.test(publicQuote.publicEvidence.challengeSha256)
   &&local.publicEvidence.challengeSha256!==publicQuote.publicEvidence.challengeSha256,'quotes must use independent fresh challenges');
  const hostAfter=await authority(),routingAfter=await ingress(),after=await runtime();
  for(const k of ['registryId','acceptedOwner','payoutWallet','operator','endpoint','active'])need(hostBefore[k]===hostAfter[k],'host authority changed during launch verification');
  need(routingBefore.bindingDigest===routingAfter.bindingDigest,'ingress changed during launch verification');
  for(const k of ['unit','invocation','bundleDigest','hostPid','guestPid','protectedVmCount'])need(before[k]===after[k],'runtime changed during launch verification');
  quoteFresh(local);quoteFresh(publicQuote);need(now()>=started&&now()-started<=MAX_QUOTE_AGE_MS,'combined launch verification expired');
  const publicPart=q=>Object.fromEntries(['requestedAt','verifiedAt','endpoint','identity','encKey','measurement','measurementSha256','manifestSha256','challengeSha256','quoteSha256','vcekVerified','minimumTcbChecked','vmpl','debugAllowed','migrationAgentAllowed'].map(k=>[k,q.publicEvidence[k]]));
  const observation={startedAt:started,finishedAt:now(),runtime:after,ingress:routingAfter,host:hostAfter,localQuote:publicPart(local),publicQuote:publicPart(publicQuote)};
  const evidenceDigest=hash(observation);
  return {outcome:'pass',evidence:{...observation,evidenceDigest,resolves:{'custodian.ingress':{ok:true,by:evidenceDigest},'resources.twoVm':{ok:true,by:evidenceDigest},'custodian.launched':{ok:true,by:evidenceDigest}},
   scope:'One capture-only SNP custodian launch with verified temporary ingress and reserved capacity for one recipient. Single-seat bootstrap; not decentralized custody, committee creation, rollback protection or secret lifecycle proof.'}};
 }catch(e){if(e?.[LOCAL])throw e;throw Error('canary launch verification refused: live evidence collection failed');}
}
