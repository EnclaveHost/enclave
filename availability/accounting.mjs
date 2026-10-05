// Inputs are a finalized ledger event replay and independently verified capacity
// certificates. Network acquisition/signature checking belongs to evidence.mjs
// and the chain adapter; caller-supplied utilization is never an input.
const bi = (x, name) => {
  if (typeof x !== 'bigint' || x < 0n) throw new TypeError(`${name}: nonnegative bigint required`);
  return x;
};
const min = (a,b) => a < b ? a : b;
const max = (a,b) => a > b ? a : b;

export function observeMarket({classId, nowSec, windowSec, capacities, services, queued = [],
  verificationIds = new Set(), anchorRate6, maxQueuedUnits, maxDemandPerOwnerUnits}) {
  for (const [k,v] of Object.entries({nowSec,windowSec,anchorRate6,maxQueuedUnits,maxDemandPerOwnerUnits})) bi(v,k);
  if (!classId || !windowSec || !anchorRate6) throw new Error('class, window and anchor required');
  const start=nowSec > windowSec ? nowSec-windowSec : 0n;
  const active=new Map(), groups=new Map();
  // Reject aliases instead of summing the same machine's capacity twice. If
  // independent certificates disagree, that machine contributes NO capacity.
  for (const c of capacities) {
    for(const k of ['issuedSec','expiresSec','units','spareUnits','minimumRate6']) bi(c[k],k);
    if (c.classId !== classId || c.issuedSec>nowSec || c.expiresSec<=nowSec || c.units===0n) continue;
    if (!c.hardwareId || !c.hostId || !c.operator || c.spareUnits>c.units) throw new Error('invalid capacity identity');
    const prior=groups.get(c.hardwareId);
    if (prior && (prior.hostId!==c.hostId || prior.units!==c.units || prior.operator!==c.operator)) {
      groups.set(c.hardwareId,{conflict:true}); continue;
    }
    if (prior?.conflict) continue;
    if (!prior || c.issuedSec>prior.issuedSec) groups.set(c.hardwareId,c);
  }
  let qualifiedSupplyUnits=0n;
  for(const c of groups.values()) {
    if(c.conflict) continue;
    // Certificate has to cover the ENTIRE observation window. New supply
    // requires a qualification history; a certificate issued now isn't a
    // retroactive claim that this capacity was available all hour.
    if(c.issuedSec>start) continue;
    if(active.has(c.hostId)) throw new Error('ambiguous host capacity');
    active.set(c.hostId,c); qualifiedSupplyUnits+=c.units*windowSec;
  }
  const demandByOwner=new Map(), seen=new Set(), intervals=new Map();
  for(const s of services) {
    for(const k of ['startSec','endSec','shareMilli','paid6']) bi(s[k],k);
    if(!s.eventId || !s.deploymentId || !s.owner) throw new Error('incomplete service event');
    if(seen.has(s.eventId)) continue; seen.add(s.eventId);
    if(s.classId!==classId || verificationIds.has(s.deploymentId) || s.paid6===0n) continue;
    const c=active.get(s.hostId);
    if(!c || s.owner.toLowerCase()===c.operator.toLowerCase() || s.owner.toLowerCase()===c.payoutWallet?.toLowerCase()) continue;
    if(s.endSec<=s.startSec || s.shareMilli>1000n || s.endSec>nowSec) throw new Error('invalid service interval');
    const a=max(start,s.startSec),b=min(nowSec,s.endSec); if(b<=a) continue;
    const prior=intervals.get(s.deploymentId)||[];
    if(prior.some(([x,y])=>a<y && b>x)) throw new Error('overlapping paid service');
    prior.push([a,b]); intervals.set(s.deploymentId,prior);
    const units=c.units*s.shareMilli*(b-a)/1000n;
    const owner=s.owner.toLowerCase(); demandByOwner.set(owner,(demandByOwner.get(owner)||0n)+units);
  }
  let paidDemandUnits=0n;
  for(const v of demandByOwner.values()) paidDemandUnits+=min(v,maxDemandPerOwnerUnits);
  let queuedDemandUnits=0n;
  const seenJobs=new Set();
  for(const q of queued) {
    for(const k of ['requestedUnits','backedBalance6']) bi(q[k],k);
    if(!q.id || !q.owner) throw new Error('incomplete queued job');
    if(q.classId!==classId || verificationIds.has(q.id) || seenJobs.has(q.id)
      || q.compatible!==true || q.active!==true || q.leased!==false) continue;
    seenJobs.add(q.id);
    // The anchor is USDC / normalized unit-second. Tiny deposits buy only
    // tiny queue weight, even if their requested allocation is enormous.
    const units=min(q.requestedUnits*windowSec,q.backedBalance6/anchorRate6);
    const owner=q.owner.toLowerCase(),used=demandByOwner.get(owner)||0n;
    const room=used>=maxDemandPerOwnerUnits ? 0n : maxDemandPerOwnerUnits-used;
    const accepted=min(units,room); demandByOwner.set(owner,used+accepted);
    queuedDemandUnits+=accepted;
  }
  queuedDemandUnits=min(queuedDemandUnits,maxQueuedUnits);
  return {classId,atSec:nowSec,windowSec,paidDemandUnits:paidDemandUnits+queuedDemandUnits,
    qualifiedSupplyUnits,completedDemandUnits:paidDemandUnits,queuedDemandUnits,
    hosts:[...active.values()]};
}
