// Apps on the Enclave network (policy v5, docs/design/enclave-network.md): which circuits each app needs, from which
// providers, kept healthy, withdrawn the moment anything they depend on lapses. Same outward shape as CircuitManager
// (configure / reconcile / enforceAdmission / publishApp / status / apps), so the agent can run both side by side.
import {EventEmitter} from 'node:events';
import {validateNetworkPolicy,networkUse,networkPolicyHash} from './network-policy.mjs';
import {recordHash} from './route-record.mjs';
import {validateAppNames} from './app-ingress.mjs';
import {transientProofError} from './lease-reader.mjs';
const PROBE_FAILURES=3,PROBE_EVERY_MS=20000,COOLDOWN_MAX_MS=30*60000,STABLE_MS=10*60000;
// Near routes: an app's name lists the circuits within this of its nearest one (the larger of the two); the rest stand by.
const NEAR_MARGIN_MS=40,NEAR_MARGIN=0.25;
// A route probe crosses two tunnels, so one slow handshake is ordinary: these transport failures fail a circuit only
// after PROBE_FAILURES in a row; a mismatch or refusal fails it at once.
export function transientRouteError(e){
 return transientProofError(e)||['TLS handshake timeout','SOCKS connection aborted','SOCKS connection closed','SOCKS closed during handshake','SOCKS connect refused'].includes(e?.message);
}

// Two circuits never share a provider, a guard is never its own exit, and every provider fits the price limit and
// offers the role. Distinct addresses are all this can check: it does not prove distinct operators (the Network tab
// says so). -> [{guard, exit}] (length = routes) or throws why not.
// distance (near routes, a Map providerId -> ms from this host): among equally priced providers the nearest is taken
// first, and the guard is chosen before the exit, so the first circuit is the host's nearest provider in front of it and
// the next nearest behind that. A provider with no measurement comes after every measured one. Without it nothing changes.
// oneHop (the owner's guard:false on a host whose operator allows it): each circuit is one provider, {guard:null, exit};
// the same order, so with distance the nearest exit comes first. Circuits still never share a provider.
export function selectNetworkCircuits(providers,{routes,ingress,egress,maxPricePerGiB6,keep=[],cooldown=new Map(),now=Date.now(),distance=null,oneHop=false}){
 const cool=p=>(cooldown.get(p.providerId)||0)>now;
 const fits=p=>p.pricePerGiB6<=maxPricePerGiB6&&p.qualifiedUntil>now&&!cool(p);
 const guards=providers.filter(p=>fits(p)&&p.eligibleRoles.includes('guard'));
 const exits=providers.filter(p=>fits(p)&&(!ingress||p.eligibleRoles.includes('ingress'))&&(!egress||p.eligibleRoles.includes('egress')));
 const used=new Set(keep.flatMap(c=>[c.guard?.address,c.exit.address]).filter(Boolean)),out=[...keep];
 // cheapest first, then the one qualified longest (stable), then id for determinism
 const far=p=>distance?.get(p.providerId)??Infinity,nearer=(a,b)=>far(a)===far(b)?0:far(a)-far(b);
 const order=(a,b)=>a.pricePerGiB6-b.pricePerGiB6||nearer(a,b)||b.qualifiedUntil-a.qualifiedUntil||a.providerId.localeCompare(b.providerId);
 if(oneHop){
  for(const exit of exits.filter(p=>!used.has(p.address)).sort(order)){if(out.length>=routes)break;used.add(exit.address);out.push({guard:null,exit});}
  if(!out.length)throw new Error(`not enough qualified providers: a one-hop circuit needs 1 (${exits.length} exit candidates)`);
  out.short=out.length<routes?`${out.length} of ${routes} route(s): not enough qualified providers (${routes} distinct needed; ${exits.length} exit candidates)`:null;
  return out;
 }
 while(out.length<routes){
  if(distance){
   const free=p=>!used.has(p.address);
   const guard=guards.filter(free).sort(order).find(g=>exits.some(x=>free(x)&&x.address!==g.address));if(!guard)break;used.add(guard.address);
   const exit=exits.filter(free).sort(order)[0];used.add(exit.address);
   out.push({guard,exit});continue;
  }
  const exit=exits.filter(p=>!used.has(p.address)).sort(order)[0];if(!exit)break;used.add(exit.address);
  const guard=guards.filter(p=>!used.has(p.address)).sort(order)[0];if(!guard){used.delete(exit.address);break;}used.add(guard.address);
  out.push({guard,exit});
 }
 // fewer circuits than asked is degraded service, not none: build what the qualified providers allow (the caller reports
 // the shortfall); only when not even one circuit is possible is there nothing to build
 if(!out.length)throw new Error(`not enough qualified providers: a circuit needs 2 distinct providers (${guards.length} guard, ${exits.length} exit candidates)`);
 out.short=out.length<routes?`${out.length} of ${routes} route(s): not enough qualified providers (${routes*2} distinct needed; ${guards.length} guard, ${exits.length} exit candidates)`:null;
 return out;
}

export class EnclaveNetworkManager extends EventEmitter {
 // direct: {runtime (DirectRuntime), qualification()} on a host that opted in to direct hosting with a public address
 // paid: {eligible(app, provider), meter(apps) -> [{app, circuit, reason}]} (paid-network.mjs) when priced providers may be used
 // hostEgress: {allows(id), start({deploymentId})} (host-egress.mjs) on a host whose operator lets apps use its own connection
 // distance: async providers -> Map(providerId -> ms) (provider-distance.mjs) on a host whose operator turned near routes on
 // oneHop: {allows(id)} (enclave-network-host.mjs) on a host whose operator lets these apps have circuits without a guard;
 //   used only for an app whose owner signed guard:false (plan)
 constructor({runtime,admission,providers,byoConfig,probe,probeEgress,publish,direct=null,paid=null,hostEgress=null,distance=null,oneHop=null,now=Date.now,log=()=>{}}){
  super();Object.assign(this,{runtime,admission,providers,byoConfig,probe,probeEgress,publish,direct,paid,hostEgress,distance,oneHop,now,log});
  this.apps=new Map();this.cooldown=new Map();this.drops=new Map();this.closed=false;this.busy=false;this.publications=new Map();this.reconciling=new Map();this.retiring=new Map();
 }
 handles(policy){return policy?.version===5;}
 async configure(apps){
  const next=new Map();
  for(const app of apps){
   const policy=validateNetworkPolicy(app.policy),id=policy.deploymentId;
   if(next.has(id))throw new Error('duplicate app');validateAppNames(id,app.names);
   const fingerprint=recordHash({policy,names:app.names,startupEgress:app.startupEgress===true,isPublic:app.isPublic!==false});
   const old=this.apps.get(id);
   next.set(id,old?.fingerprint===fingerprint?old:{...app,policy,id,fingerprint,circuits:[],error:'starting',fallbackActive:false});
  }
  // detached first, synchronously: an allocation still in flight for a replaced or removed app is retired when it returns
  const gone=[...this.apps].filter(([id,old])=>next.get(id)!==old).map(([,old])=>old);for(const old of gone)old.detached=true;
  for(const old of gone)await this.withdraw(old,'app removed or policy changed');
  this.apps=next;
 }
 authorizationUntil(id){
  if(!this.admission.allows(id))return 0;
  // the host wallet's allow (wallet-admission.mjs), where the gate carries one, caps it like the lease and the proof
  const e=Math.min(this.admission.leases.get(id).validUntil,this.admission.proofs.get(id).validUntil,this.admission.walletUntil?.(id)??Infinity);return e>this.now()?e:0;
 }
 enforceAdmission(){
  for(const app of this.apps.values()){const e=this.authorizationUntil(app.id);for(const c of app.circuits)c.admit(e);if(!e&&app.circuits.length)void this.withdraw(app,'authorization expired').catch(err=>this.log(err.message));}
 }
 // A removed circuit can still have a live child process. Keep it in the barrier until close actually succeeds;
 // a rejected close stays unacknowledged. An allocation already in flight must settle before a hold is acknowledged.
 // Scoped to apps not authorized now: an allowed app's allocation or failed close cannot withhold another app's
 // acknowledgement. A retiring circuit of an unknown app blocks every acknowledgement.
 admissionSettled(){
  const held=id=>id===undefined||!this.authorizationUntil(id);
  for(const r of this.retiring.values())if(held(r.id))return false;
  for(const id of this.reconciling.keys())if(held(id))return false;
  return [...this.apps.values()].every(app=>!held(app.id)||app.circuits.length===0);
 }
 retireCircuit(c,reason,id){
  const old=this.retiring.get(c);if(old)return old.op;
  // Defer close until after registration: synchronous 'down' events must not hide this outstanding withdrawal.
  const op=Promise.resolve().then(()=>c.close(reason)),entry={op,id:id??c.deploymentId};this.retiring.set(c,entry);
  void op.then(()=>{if(this.retiring.get(c)===entry)this.retiring.delete(c);},()=>{});
  return op;
 }
 async withdraw(app,reason){
  const old=app.circuits.splice(0);app.error=reason;
  for(const c of old){c.healthy=false;c.admit(0);}
  // Local traffic stops independently of a slow/unreachable route distributor.
  const closing=Promise.all(old.map(c=>this.retireCircuit(c,reason,app.id)));
  const publication=this.publishApp(app).catch(e=>this.log('route withdrawal: '+e.message));
  await closing;
  await publication;
 }
 // strike:false - the circuit closes for a reason that is not the providers' fault (a refused paid debit)
 async fail(app,circuit,reason,{strike=true}={}){
  if(!app.circuits.includes(circuit))return;
  circuit.healthy=false;app.circuits=app.circuits.filter(c=>c!==circuit);circuit.admit(0);
  // a provider whose circuits keep dying soon after coming up waits longer each time (60 s doubling to 30 min)
  const early=circuit.upAt!==undefined&&this.now()-circuit.upAt<STABLE_MS;
  for(const p of circuit.kind==='network'&&strike?[circuit.failureRole==='guard'&&circuit.providers.guard?circuit.providers.guard:circuit.providers.exit]:[]){
   if(early)this.strike(p);else{this.drops.delete(p.providerId);this.strike(p);}
  }
  app.error=reason;app.lastFailure={at:this.now(),circuit:circuit.id,reason};this.log(`app ${app.id.slice(0,10)} circuit ${circuit.id}: ${reason}`);
  const closing=this.retireCircuit(circuit,reason,app.id);
  const publication=this.publishApp(app).catch(e=>this.log('route withdrawal: '+e.message));
  await closing;await publication;
 }
 async publishApp(app){
  const op=(this.publications.get(app.id)||Promise.resolve()).catch(()=>{}).then(async()=>{
   const routes=!this.closed&&this.authorizationUntil(app.id)>this.now()?this.listed(app)
    .map(c=>({circuit:c.id,address:c.address,port:443,transport:c.kind==='direct'?'direct':'enclave-network'})):[];
   await this.publish(app.id,routes);this.emit('change',this.status());
  });
  this.publications.set(app.id,op);try{await op;}finally{if(this.publications.get(app.id)===op)this.publications.delete(app.id);}
 }
 // The circuits an app's name lists: every healthy one that carries its website. With near routes, only those about as
 // near as the nearest (nearest first): a name that also listed a circuit through the far providers would send every
 // second visitor that way. The others stay built and verified, and are listed the moment no near one is healthy.
 // A circuit with a provider nobody measured counts as far; when no circuit has measurements, all are listed as before.
 // A one-hop circuit is as far as its one provider.
 listed(app){
  const up=app.circuits.filter(c=>c.healthy&&!c.closed&&c.ingress&&c.address);
  const far=c=>c.kind==='network'&&!c.providers.guard?(Number.isFinite(c.near?.exit)?c.near.exit:Infinity):Number.isFinite(c.near?.guard)&&Number.isFinite(c.near?.exit)?c.near.guard+c.near.exit:Infinity,best=Math.min(...up.map(far));
  if(!Number.isFinite(best)||up.some(c=>c.kind!=='network'))return up;
  return up.filter(c=>far(c)<=best+Math.max(NEAR_MARGIN_MS,best*NEAR_MARGIN)).sort((a,b)=>far(a)-far(b));
 }
 // What this app needs right now: network circuits (count, ingress, egress) and/or its own egress tunnel: the owner's BYO
 // WireGuard ('byo') or this host's own connection ('host'). Either may fall back to an Enclave-network egress circuit.
 // oneHop: its network circuits have no guard - the owner signed guard:false AND this host's operator allows it for the app.
 plan(app){
  const use=networkUse(app.policy),pub=app.isPublic!==false;
  const own=use.egress==='byo-wireguard'?'byo':use.egress==='host'?'host':null;
  const ownUp=!!own&&app.circuits.some(c=>c.kind===own&&c.healthy&&!c.closed);
  const fallback=!!own&&use.fallback==='enclave-network'&&!ownUp&&app.ownFailedAt!==undefined;
  const ingress=pub&&use.ingress==='enclave-network';
  const egress=use.egress==='enclave-network';
  return {own,byo:own==='byo',host:own==='host',ingress,egress,fallback,routes:(ingress||egress)?(use.enclaveNetwork?.routes||2):0,maxPricePerGiB6:use.enclaveNetwork?.maxPricePerGiB6??0,direct:use.egress==='direct',
   oneHop:use.enclaveNetwork?.guard===false&&!!this.oneHop?.allows(app.id)};
 }
 async reconcile(){
  if(this.busy||this.closed)return;this.busy=true;const pending=[];
  try{
   this.enforceAdmission();
   // the provider directory only for apps that use the Enclave network at all (the policy then carries its settings)
   const providers=[...this.apps.values()].some(a=>'enclaveNetwork' in a.policy)?await this.providers():[];
   // near routes: how far each provider is from this host, for the circuits this pass builds (none measured: as without)
   const near=this.distance&&providers.length?await this.distance(providers).then(m=>m.size?m:null,e=>{this.log('near routes: '+e.message);return null;}):null;
   for(const app of this.apps.values()){
    if(this.reconciling.has(app.id))continue;
    const op=this.reconcileApp(app,providers,near).catch(e=>{app.error=e.message;this.log(`app ${app.id.slice(0,10)}: ${e.message}`);}).finally(()=>this.reconciling.delete(app.id));
    this.reconciling.set(app.id,op);pending.push(op);
   }
  }finally{this.busy=false;}
  await Promise.all(pending);
  // paid hops: meter and authorize the debit; a refused debit (budget spent, authorization gone) closes the circuit
  if(this.paid&&!this.closed)for(const {app,circuit,reason} of await this.paid.meter([...this.apps.values()]).catch(e=>{this.log('paid meter: '+e.message);return [];}))await this.fail(app,circuit,reason,{strike:false});
 }
 async reconcileApp(app,providers,near=null){
  if(!this.authorizationUntil(app.id)){if(app.circuits.length)await this.withdraw(app,'not authorized');app.error='waiting for lease and guest proof';return;}
  const plan=this.plan(app);
  if(plan.direct){
   if(!this.direct){app.error='direct hosting is not available on this host';return;}
   const live=app.circuits.find(c=>c.kind==='direct');
   if(live){
    const q=await this.direct.qualification().catch(()=>null);
    if(!q||!(q.expiresAt>this.now())){await this.fail(app,live,'this host\'s direct-hosting qualification lapsed');return;}
    live.qualifiedUntil=q.expiresAt;
   }
   await this.checkHealth(app);
   if(app.circuits.some(c=>c.kind==='direct'))return void(app.error=null,await this.publishApp(app));
   let c;
   try{
    // a direct route exists only while this host's qualification for its public address is current
    const q=await this.direct.qualification();if(!q||!(q.expiresAt>this.now()))throw new Error('this host has no current direct-hosting qualification');
    c=await this.direct.runtime.start({deploymentId:app.id,names:app.names,policy:app.policy});
    Object.assign(c,{kind:'direct',ingress:true,egressReady:true,qualifiedUntil:q.expiresAt,providers:{direct:{address:c.address}}});
    this.adopt(app,c);await this.probe(app,c);if(c.closed)throw new Error('direct route failed during verification');
    c.healthy=true;c.checkedAt=this.now();c.upAt=this.now();app.error=null;await this.publishApp(app);
   }catch(e){if(c&&app.circuits.includes(c))await this.fail(app,c,e.message);else if(c)await this.retireCircuit(c,e.message,app.id);app.error='direct hosting: '+e.message;}
   return;
  }
  // revocation: a provider that is no longer eligible (qualification lapsed, record changed, role or price) loses its circuits now
  const byId=new Map(providers.map(p=>[p.providerId,p]));
  for(const c of [...app.circuits])if(c.kind==='network'){
   const one=!c.providers.guard,g=one?null:byId.get(c.providers.guard.providerId),x=byId.get(c.providers.exit.providerId);
   const same=(a,b)=>a&&a.address===b.address&&a.wgGuardKey===b.wgGuardKey&&a.wgExitKey===b.wgExitKey&&a.qualifiedUntil>this.now();
   const fits=x&&x.pricePerGiB6<=plan.maxPricePerGiB6&&this.paidOK(app,x)&&(!c.ingress||x.eligibleRoles.includes('ingress'))&&(!c.egressReady||x.eligibleRoles.includes('egress'))
    &&(one||(this.paidOK(app,g)&&g?.eligibleRoles.includes('guard')));
   const shape=c.fallback?plan.fallback&&!c.ingress:c.ingress===plan.ingress&&(c.egressReady===plan.egress);
   if((!one&&!same(g,c.providers.guard))||!same(x,c.providers.exit)||!fits)await this.fail(app,c,'provider no longer qualified for this circuit');
   // a circuit without a guard exists only while the owner's guard:false and the operator's opt-in both stand (not the provider's fault)
   else if(one!==plan.oneHop)await this.fail(app,c,one?'one hop is no longer permitted for this app':'circuit no longer matches the policy',{strike:false});
   else if(!shape)await this.fail(app,c,'circuit no longer matches the policy');
  }
  // the operator withdrew this host's own connection from the app (hostEgress changed on a config reload): its host circuit goes
  // now, and the app's fallback (if its owner chose one) takes over below
  for(const c of [...app.circuits])if(c.kind==='host'&&!this.hostEgress?.allows(app.id))await this.fail(app,c,'this host no longer offers its own connection to this app');
  await this.checkHealth(app);
  // the app's own egress: BYO WireGuard, or this host's own connection (only where the operator offers it to this app)
  if(plan.own&&!app.circuits.some(c=>c.kind===plan.own)){
   let c;
   try{
    if(plan.byo){const cfg=await this.byoConfig(app);c=await this.runtime.start({deploymentId:app.id,names:app.names,kind:'byo',byo:cfg,egress:true});this.adopt(app,c);}
    else{
     if(!this.hostEgress?.allows(app.id))throw new Error('this host does not offer its own connection to this app');
     c=await this.hostEgress.start({deploymentId:app.id});this.adopt(app,c);
     await this.probeEgress?.(app,c);if(c.closed)throw new Error('host egress failed during verification');
     c.checkedAt=this.now();c.upAt=this.now();
    }
    c.healthy=true;app.ownFailedAt=undefined;app.fallbackActive=false;
   }catch(e){
    if(c&&app.circuits.includes(c))await this.fail(app,c,e.message);else if(c)await this.retireCircuit(c,e.message,app.id);
    app.ownFailedAt=this.now();app.error=(plan.byo?'BYO WireGuard: ':'host egress: ')+e.message;this.log(`app ${app.id.slice(0,10)}: ${app.error}`);
   }
  }
  const want=this.plan(app);
  app.fallbackActive=want.fallback;
  // the app's own circuits (website, and egress unless its own tunnel carries it), plus with an active authorized fallback one
  // egress-only circuit of its own: failing over and back never touches the circuits that carry the website
  const groups=[{routes:want.routes,ingress:want.ingress,egress:want.egress,fallback:false}];
  if(want.fallback)groups.push({routes:1,ingress:false,egress:true,fallback:true});
  let error=null,degraded=null;
  for(const g of groups){
   const have=()=>app.circuits.filter(c=>c.kind==='network'&&!!c.fallback===g.fallback);
   if(have().length>=g.routes)continue;
   const keep=have().map(c=>({guard:c.providers.guard||null,exit:c.providers.exit}));
   // prefer providers the app's other circuits do not use; share them only when there are not enough
   const others=new Set(app.circuits.filter(c=>c.kind==='network'&&!!c.fallback!==g.fallback).flatMap(c=>[c.providers.guard?.address,c.providers.exit.address]).filter(Boolean));
   const pick=list=>selectNetworkCircuits(list.filter(p=>this.paidOK(app,p)),{routes:g.routes,ingress:g.ingress,egress:g.egress,maxPricePerGiB6:want.maxPricePerGiB6,keep,cooldown:this.cooldown,now:this.now(),distance:near,oneHop:want.oneHop});
   let choice;
   try{try{choice=pick(providers.filter(p=>!others.has(p.address)));if(choice.short&&others.size)throw new Error(choice.short);}catch{choice=pick(providers);}}
   catch(e){const n=keep.length;if(n)degraded=`${n} of ${g.routes} route(s): ${e.message}`;else error=(g.fallback?'fallback: ':'')+e.message;continue;}
   if(choice.short)degraded=choice.short;
   for(const {guard,exit} of choice.slice(keep.length)){
    if(this.closed||!this.authorizationUntil(app.id))return;
    let c;
    try{
     c=await this.runtime.start({deploymentId:app.id,names:app.names,kind:'network',guard,exit,ingress:g.ingress,egress:g.egress,fallback:g.fallback});
     this.adopt(app,c);
     if(near)c.near={guard:guard?near.get(guard.providerId)??null:null,exit:near.get(exit.providerId)??null};
     if(c.ingress)await this.probe(app,c);else await this.probeEgress?.(app,c);
     if(c.closed)throw new Error('circuit failed during verification');
     c.healthy=true;c.checkedAt=this.now();c.upAt=this.now();await this.publishApp(app);
    }catch(e){
     const role=e.providerRole||c?.failureRole||'public',p=role==='guard'&&guard?guard:exit;
     if(!e.detached)this.strike(p);
     if(c&&app.circuits.includes(c))await this.fail(app,c,e.message);else if(c)await this.retireCircuit(c,e.message,app.id);
     this.log(`app ${app.id.slice(0,10)}: ${e.message}`);
    }
   }
   const healthy=have().filter(c=>c.healthy).length;
   if(!healthy)error=error||(g.fallback?'fallback: ':'')+'no circuit could be built';
   else if(healthy<g.routes)degraded=degraded||`${healthy} of ${g.routes} route(s)`;
  }
  // the app's own tunnel being down stays the reason unless the owner's fallback is carrying the egress
  const ownDown=!!plan.own&&!app.circuits.some(c=>c.kind===plan.own)&&!want.fallback;
  app.error=error||(ownDown?app.error:null);app.degraded=degraded;
  await this.publishApp(app);
 }
 // One incident at a provider fails the circuits of every app through it at once: failures while it is already cooling
 // down are the same incident and do not lengthen the wait (five apps would otherwise turn one minute into sixteen).
 strike(p){
  if((this.cooldown.get(p.providerId)||0)>this.now())return;
  const n=(this.drops.get(p.providerId)||0)+1;this.drops.set(p.providerId,n);this.cooldown.set(p.providerId,this.now()+Math.min(60000*2**(n-1),COOLDOWN_MAX_MS));
 }
 paidOK(app,p){return !p||!(p.pricePerGiB6>0)||(!!this.paid&&this.paid.eligible(app,p));}
 adopt(app,c){
  if(this.closed||app.detached)throw Object.assign(new Error('app removed or policy changed during allocation'),{detached:true});
  c.admit(this.authorizationUntil(app.id));c.on('down',reason=>{void this.fail(app,c,reason).catch(e=>this.log(e.message));});app.circuits.push(c);}
 async checkHealth(app){
  for(const c of [...app.circuits]){
   if(c.closed||this.now()-(c.checkedAt||0)<PROBE_EVERY_MS)continue;
   try{if(c.ingress)await this.probe(app,c);else await this.probeEgress?.(app,c);if(!app.circuits.includes(c))continue;c.checkedAt=this.now();c.probeFailures=0;c.healthy=true;}
   catch(e){
    if(!app.circuits.includes(c)||c.closed)continue;c.probeFailures=(c.probeFailures||0)+1;
    if(transientRouteError(e)&&c.probeFailures<PROBE_FAILURES){c.checkedAt=this.now()-PROBE_EVERY_MS+5000;this.log(`app ${app.id.slice(0,10)} circuit ${c.id}: probe ${c.probeFailures}/${PROBE_FAILURES} failed: ${e.message}`);continue;}
    await this.fail(app,c,'route verification failed: '+e.message);
   }
  }
 }
 // the modes this host can serve an app in (the Network tab offers only these): the Enclave network and the owner's own
 // WireGuard everywhere; direct only on a host that opted in with a public address (its qualification is checked per app);
 // host only where the operator offers its own connection to this app
 hostModes(id){return ['enclave-network','byo-wireguard',...(this.direct?['direct']:[]),...(this.hostEgress?.allows(id)?['host']:[])];}
 status(){return [...this.apps.values()].map(app=>{const plan=this.plan(app),modes=this.hostModes(app.id),listed=new Set(this.listed(app));return {deploymentId:app.id,transport:app.policy.mode,policyNonce:app.policy.nonce,policyHash:networkPolicyHash(app.policy),modes,
  // this host's operator allows circuits without a guard for this app (they are built only under the owner's guard:false)
  oneHop:!!this.oneHop?.allows(app.id),
  ready:!app.error&&app.circuits.length>0&&app.circuits.every(c=>c.healthy)&&!!this.authorizationUntil(app.id),error:app.error||null,degraded:app.degraded||null,fallbackActive:!!app.fallbackActive,
  ingress:plan.ingress,egress:plan.byo?'byo-wireguard':plan.host?'host':plan.egress?'enclave-network':'none',
  circuits:app.circuits.map(c=>({id:c.id,kind:c.kind,healthy:!!c.healthy,address:c.address||null,ingress:!!c.ingress,egress:!!c.egressReady,fallback:!!c.fallback,
   guard:c.providers.guard?{providerId:c.providers.guard.providerId,address:c.providers.guard.address,region:c.providers.guard.region}:null,
   direct:c.kind==='direct'?{address:c.address}:null,
   exit:c.providers.exit?{providerId:c.providers.exit.providerId,address:c.providers.exit.address,region:c.providers.exit.region}:null,
   handshakeAgeMs:c.stats?.inner?.handshakeAgeMs??null,bytes:c.stats?.app||null,
   // the circuit's TCP loss/recovery counters and its pacer's wait (enclave-wg stats): what a stalled upload looked like
   tcp:c.stats?.inner?.tcp||null,paceSleptMs:c.stats?.paceSleptMs??null,
   // near routes: this host's measured distance to the circuit's providers, and whether the circuit is healthy but
   // left out of the app's name because a nearer one is listed
   rttMs:c.near||null,standby:!!c.healthy&&!!c.ingress&&!c.closed&&!!c.address&&!listed.has(c)}))};});}
 async close(){if(this.closed)return;this.closed=true;for(const app of this.apps.values())await this.withdraw(app,'agent stopped').catch(()=>{});}
}
