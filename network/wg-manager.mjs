// Apps on the Enclave network (policy v5, docs/design/enclave-network.md): which circuits each app needs, from which
// providers, kept healthy, withdrawn the moment anything they depend on lapses. Same outward shape as CircuitManager
// (configure / reconcile / enforceAdmission / publishApp / status / apps), so the agent can run both side by side.
import {EventEmitter} from 'node:events';
import {validateNetworkPolicy,networkUse,networkPolicyHash} from './network-policy.mjs';
import {recordHash} from './route-record.mjs';
import {validateAppNames} from './app-ingress.mjs';
import {transientRouteError} from './circuit-manager.mjs';
const PROBE_FAILURES=3,PROBE_EVERY_MS=20000,COOLDOWN_MAX_MS=30*60000,STABLE_MS=10*60000;

// Two circuits never share a provider, a guard is never its own exit, and every provider fits the price limit and
// offers the role. Distinct addresses are all this can check: it does not prove distinct operators (the Network tab
// says so). -> [{guard, exit}] (length = routes) or throws why not.
export function selectNetworkCircuits(providers,{routes,ingress,egress,maxPricePerGiB6,keep=[],cooldown=new Map(),now=Date.now()}){
 const cool=p=>(cooldown.get(p.providerId)||0)>now;
 const fits=p=>p.pricePerGiB6<=maxPricePerGiB6&&p.qualifiedUntil>now&&!cool(p);
 const guards=providers.filter(p=>fits(p)&&p.eligibleRoles.includes('guard'));
 const exits=providers.filter(p=>fits(p)&&(!ingress||p.eligibleRoles.includes('ingress'))&&(!egress||p.eligibleRoles.includes('egress')));
 const used=new Set(keep.flatMap(c=>[c.guard.address,c.exit.address])),out=[...keep];
 // cheapest first, then the one qualified longest (stable), then id for determinism
 const order=(a,b)=>a.pricePerGiB6-b.pricePerGiB6||b.qualifiedUntil-a.qualifiedUntil||a.providerId.localeCompare(b.providerId);
 while(out.length<routes){
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
 constructor({runtime,admission,providers,byoConfig,probe,probeEgress,publish,direct=null,now=Date.now,log=()=>{}}){
  super();Object.assign(this,{runtime,admission,providers,byoConfig,probe,probeEgress,publish,direct,now,log});
  this.apps=new Map();this.cooldown=new Map();this.drops=new Map();this.closed=false;this.busy=false;this.publications=new Map();this.reconciling=new Map();
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
  for(const [id,old] of this.apps)if(next.get(id)!==old)await this.withdraw(old,'app removed or policy changed');
  this.apps=next;
 }
 authorizationUntil(id){
  if(!this.admission.allows(id))return 0;
  const e=Math.min(this.admission.leases.get(id).validUntil,this.admission.proofs.get(id).validUntil);return e>this.now()?e:0;
 }
 enforceAdmission(){
  for(const app of this.apps.values()){const e=this.authorizationUntil(app.id);for(const c of app.circuits)c.admit(e);if(!e&&app.circuits.length)void this.withdraw(app,'authorization expired').catch(err=>this.log(err.message));}
 }
 async withdraw(app,reason){
  const old=app.circuits.splice(0);app.error=reason;
  for(const c of old){c.healthy=false;c.admit(0);}
  await this.publishApp(app).catch(e=>this.log('route withdrawal: '+e.message));
  await Promise.all(old.map(c=>c.close(reason)));
 }
 async fail(app,circuit,reason){
  if(!app.circuits.includes(circuit))return;
  circuit.healthy=false;app.circuits=app.circuits.filter(c=>c!==circuit);circuit.admit(0);
  // a provider whose circuits keep dying soon after coming up waits longer each time (60 s doubling to 30 min)
  const early=circuit.upAt!==undefined&&this.now()-circuit.upAt<STABLE_MS;
  for(const p of circuit.kind==='network'?[circuit.failureRole==='guard'?circuit.providers.guard:circuit.providers.exit]:[]){
   if(early)this.strike(p);else{this.drops.delete(p.providerId);this.strike(p);}
  }
  app.error=reason;app.lastFailure={at:this.now(),circuit:circuit.id,reason};this.log(`app ${app.id.slice(0,10)} circuit ${circuit.id}: ${reason}`);
  await this.publishApp(app).catch(e=>this.log('route withdrawal: '+e.message));
  await circuit.close(reason);
 }
 async publishApp(app){
  const op=(this.publications.get(app.id)||Promise.resolve()).catch(()=>{}).then(async()=>{
   const routes=!this.closed&&this.authorizationUntil(app.id)>this.now()?app.circuits.filter(c=>c.healthy&&!c.closed&&c.ingress&&c.address)
    .map(c=>({circuit:c.id,address:c.address,port:443,transport:c.kind==='direct'?'direct':'enclave-network'})):[];
   await this.publish(app.id,routes);this.emit('change',this.status());
  });
  this.publications.set(app.id,op);try{await op;}finally{if(this.publications.get(app.id)===op)this.publications.delete(app.id);}
 }
 // What this app needs right now: network circuits (count, ingress, egress) and/or a BYO tunnel.
 plan(app){
  const use=networkUse(app.policy),pub=app.isPublic!==false;
  const byo=use.egress==='byo-wireguard';
  const byoUp=app.circuits.some(c=>c.kind==='byo'&&c.healthy&&!c.closed);
  const fallback=byo&&use.fallback==='enclave-network'&&!byoUp&&app.byoFailedAt!==undefined;
  const ingress=pub&&use.ingress==='enclave-network';
  const egress=use.egress==='enclave-network';
  return {byo,ingress,egress,fallback,routes:(ingress||egress)?(use.enclaveNetwork?.routes||2):0,maxPricePerGiB6:use.enclaveNetwork?.maxPricePerGiB6??0,direct:use.egress==='direct'};
 }
 async reconcile(){
  if(this.busy||this.closed)return;this.busy=true;const pending=[];
  try{
   this.enforceAdmission();
   const providers=[...this.apps.values()].some(a=>a.policy.mode!=='direct'||a.policy.fallback!=='none')?await this.providers():[];
   for(const app of this.apps.values()){
    if(this.reconciling.has(app.id))continue;
    const op=this.reconcileApp(app,providers).catch(e=>{app.error=e.message;this.log(`app ${app.id.slice(0,10)}: ${e.message}`);}).finally(()=>this.reconciling.delete(app.id));
    this.reconciling.set(app.id,op);pending.push(op);
   }
  }finally{this.busy=false;}
  await Promise.all(pending);
 }
 async reconcileApp(app,providers){
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
   }catch(e){if(c&&app.circuits.includes(c))await this.fail(app,c,e.message);else await c?.close?.(e.message);app.error='direct hosting: '+e.message;}
   return;
  }
  // revocation: a provider that is no longer eligible (qualification lapsed, record changed, role or price) loses its circuits now
  const byId=new Map(providers.map(p=>[p.providerId,p]));
  for(const c of [...app.circuits])if(c.kind==='network'){
   const g=byId.get(c.providers.guard.providerId),x=byId.get(c.providers.exit.providerId);
   const same=(a,b)=>a&&a.address===b.address&&a.wgGuardKey===b.wgGuardKey&&a.wgExitKey===b.wgExitKey&&a.qualifiedUntil>this.now();
   const fits=x&&x.pricePerGiB6<=plan.maxPricePerGiB6&&(!c.ingress||x.eligibleRoles.includes('ingress'))&&(!c.egressReady||x.eligibleRoles.includes('egress'))&&g?.eligibleRoles.includes('guard');
   const shape=c.fallback?plan.fallback&&!c.ingress:c.ingress===plan.ingress&&(c.egressReady===plan.egress);
   if(!same(g,c.providers.guard)||!same(x,c.providers.exit)||!fits)await this.fail(app,c,'provider no longer qualified for this circuit');
   else if(!shape)await this.fail(app,c,'circuit no longer matches the policy');
  }
  await this.checkHealth(app);
  // BYO egress
  if(plan.byo&&!app.circuits.some(c=>c.kind==='byo')){
   try{const cfg=await this.byoConfig(app);
    const c=await this.runtime.start({deploymentId:app.id,names:app.names,kind:'byo',byo:cfg,egress:true});
    this.adopt(app,c);c.healthy=true;app.byoFailedAt=undefined;app.fallbackActive=false;
   }catch(e){app.byoFailedAt=this.now();app.error='BYO WireGuard: '+e.message;this.log(`app ${app.id.slice(0,10)}: ${app.error}`);}
  }
  const want=this.plan(app);
  app.fallbackActive=want.fallback;
  // the app's own circuits (website, and egress unless BYO carries it), plus with an active authorized fallback one
  // egress-only circuit of its own: failing over and back never touches the circuits that carry the website
  const groups=[{routes:want.routes,ingress:want.ingress,egress:want.egress,fallback:false}];
  if(want.fallback)groups.push({routes:1,ingress:false,egress:true,fallback:true});
  let error=null,degraded=null;
  for(const g of groups){
   const have=()=>app.circuits.filter(c=>c.kind==='network'&&!!c.fallback===g.fallback);
   if(have().length>=g.routes)continue;
   const keep=have().map(c=>({guard:c.providers.guard,exit:c.providers.exit}));
   // prefer providers the app's other circuits do not use; share them only when there are not enough
   const others=new Set(app.circuits.filter(c=>c.kind==='network'&&!!c.fallback!==g.fallback).flatMap(c=>[c.providers.guard.address,c.providers.exit.address]));
   const pick=list=>selectNetworkCircuits(list,{routes:g.routes,ingress:g.ingress,egress:g.egress,maxPricePerGiB6:want.maxPricePerGiB6,keep,cooldown:this.cooldown,now:this.now()});
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
     if(c.ingress)await this.probe(app,c);else await this.probeEgress?.(app,c);
     if(c.closed)throw new Error('circuit failed during verification');
     c.healthy=true;c.checkedAt=this.now();c.upAt=this.now();await this.publishApp(app);
    }catch(e){
     const role=e.providerRole||c?.failureRole||'public',p=role==='guard'?guard:exit;
     this.strike(p);
     if(c&&app.circuits.includes(c))await this.fail(app,c,e.message);else await c?.close(e.message);
     this.log(`app ${app.id.slice(0,10)}: ${e.message}`);
    }
   }
   const healthy=have().filter(c=>c.healthy).length;
   if(!healthy)error=error||(g.fallback?'fallback: ':'')+'no circuit could be built';
   else if(healthy<g.routes)degraded=degraded||`${healthy} of ${g.routes} route(s)`;
  }
  // a BYO tunnel that is down stays the reason unless the owner's fallback is carrying the egress
  const byoDown=plan.byo&&!app.circuits.some(c=>c.kind==='byo')&&!want.fallback;
  app.error=error||(byoDown?app.error:null);app.degraded=degraded;
  await this.publishApp(app);
 }
 // One incident at a provider fails the circuits of every app through it at once: failures while it is already cooling
 // down are the same incident and do not lengthen the wait (five apps would otherwise turn one minute into sixteen).
 strike(p){
  if((this.cooldown.get(p.providerId)||0)>this.now())return;
  const n=(this.drops.get(p.providerId)||0)+1;this.drops.set(p.providerId,n);this.cooldown.set(p.providerId,this.now()+Math.min(60000*2**(n-1),COOLDOWN_MAX_MS));
 }
 adopt(app,c){c.admit(this.authorizationUntil(app.id));c.on('down',reason=>{void this.fail(app,c,reason).catch(e=>this.log(e.message));});app.circuits.push(c);}
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
 status(){return [...this.apps.values()].map(app=>{const plan=this.plan(app);return {deploymentId:app.id,transport:app.policy.mode,policyNonce:app.policy.nonce,policyHash:networkPolicyHash(app.policy),
  ready:!app.error&&app.circuits.length>0&&app.circuits.every(c=>c.healthy)&&!!this.authorizationUntil(app.id),error:app.error||null,degraded:app.degraded||null,fallbackActive:!!app.fallbackActive,
  ingress:plan.ingress,egress:plan.byo?'byo-wireguard':plan.egress?'enclave-network':'none',
  circuits:app.circuits.map(c=>({id:c.id,kind:c.kind,healthy:!!c.healthy,address:c.address||null,ingress:!!c.ingress,egress:!!c.egressReady,fallback:!!c.fallback,
   guard:c.providers.guard?{providerId:c.providers.guard.providerId,address:c.providers.guard.address,region:c.providers.guard.region}:null,
   direct:c.kind==='direct'?{address:c.address}:null,
   exit:c.providers.exit?{providerId:c.providers.exit.providerId,address:c.providers.exit.address,region:c.providers.exit.region}:null,
   handshakeAgeMs:c.stats?.inner?.handshakeAgeMs??null,bytes:c.stats?.app||null}))};});}
 async close(){if(this.closed)return;this.closed=true;for(const app of this.apps.values())await this.withdraw(app,'agent stopped').catch(()=>{});}
}
