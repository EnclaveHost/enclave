import {fallbackInventory,validatePublicFallback,publicReservations} from './public-fallback.mjs';
import {EventEmitter} from 'node:events';
import {validateCircuitPolicy,selectCircuitProviders,providerAllowedForPolicy,nknAmount,independentCircuits,providerCooldownKey} from './circuit-policy.mjs';
import {tunaInventoryForLease} from './tuna-policy.mjs';
import {recordHash} from './route-record.mjs';
import {validateAppNames} from './app-ingress.mjs';
import {transientProofError} from './lease-reader.mjs';
// A route probe crosses the guard twice (out to the public provider, back down
// its reverse tunnel), so one slow handshake is ordinary. These transport
// failures withdraw a route only after three in a row; a mismatch or refusal
// still fails it at once.
const ROUTE_PROBE_FAILURES=3,ROUTE_RETRY_MS=5000,COOLDOWN_MAX_MS=1800000;
export function transientRouteError(e) {
  return transientProofError(e)||['TLS handshake timeout','SOCKS connection aborted','SOCKS connection closed','SOCKS closed during handshake','SOCKS connect refused'].includes(e?.message);
}

const roles=['guard','public','egress'];
// A guard's own health says it accepted a connection, not that public
// allocations reached through it succeed. That is recorded separately as
// 'carry', so a guard that cannot carry is not ranked by its own uptime.
const withCarry=providers=>({...providers,carry:providers.guard});
const sameProviders=(a,b)=>roles.every(role=>['identity','address','beneficiary','asn','registryId','currency','pricePerGiB6'].every(k=>a[role][k]===b[role][k]));
export class CircuitManager extends EventEmitter {
  constructor({runtime,directRuntime,admission,inventory,wallets,probe,publish,observe=async()=>{},now=Date.now,log=()=>{}}) {
    super();Object.assign(this,{runtime,directRuntime,admission,inventory,wallets,probe,publish,observe,now,log});this.apps=new Map();this.cooldown=new Map();this.strikes=new Map();this.closed=false;this.busy=false;this.publications=new Map();this.reconcilingApps=new Map();this.reservedPublic=new Set();this.occupiedElsewhere=new Set();this.healthChecks=new Map();
  }
  async configure(apps) {
    const next=new Map(),walletOwners=new Map();
    for(const app of apps){
      const policy=validateCircuitPolicy(app.policy),id=policy.deploymentId;
      if(next.has(id)||!Array.isArray(app.names)||!app.names.length)throw new Error('duplicate app or missing names');
      validateAppNames(id,app.names);
      const direct=policy.mode==='direct';
      if(direct&&!this.directRuntime)throw new Error('direct connectivity is not configured');
      const wallets=direct?[]:await this.wallets(id);let total=0n;
      if(!Array.isArray(wallets)||(!direct&&wallets.length!==2))throw new Error('two independently funded circuit slots required');
      for(const slot of wallets)for(const role of roles){
        const wallet=slot[role];
        if(!wallet||walletOwners.has(wallet.address))throw new Error('wallet identity reused across apps, roles or circuits');
        walletOwners.set(wallet.address,id);total+=nknAmount(wallet.fundedNkn);
      }
      if(!direct&&policy.currency!=='USDC'&&total>nknAmount(policy.budgetNkn))throw new Error('funded wallets exceed app budget');
      const publicFallback=direct||policy.currency==='USDC'?null:validatePublicFallback(app.publicFallback);
      const fingerprint=recordHash({policy,names:app.names,publicFallback,startupEgress:app.startupEgress===true});
      const old=this.apps.get(id);
      next.set(id,old?.fingerprint===fingerprint?old:{...app,publicFallback,policy,id,wallets,fingerprint,circuits:[],error:'starting'});
    }
    for(const[id,old]of this.apps)if(next.get(id)!==old)await this.withdraw(old,'app removed or policy changed');
    this.apps=next;
  }
  authorizationUntil(id) {
    if(!this.admission.allows(id))return 0;
    const expiry=Math.min(this.admission.leases.get(id).validUntil,this.admission.proofs.get(id).validUntil);return expiry>this.now()?expiry:0;
  }
  async withdraw(app,reason) {
    const old=app.circuits.splice(0);app.error=reason;
    for(const circuit of old){circuit.healthy=false;circuit.admit(0);}
    await this.publishApp(app).catch(e=>this.log(`route withdrawal: ${e.message}`));
    await Promise.all(old.map(c=>c.close(reason)));
  }
  async fail(app,circuit,reason) {
    if(!app.circuits.includes(circuit))return;
    if(app.policy.mode!=='direct')void this.observe(circuit.providers,{ok:false,role:circuit.failureRole}).catch(e=>this.log(e.message));
    circuit.healthy=false;app.circuits=app.circuits.filter(c=>c!==circuit);circuit.admit(0);
    // A failure cannot cause an immediate retry of the same set of providers.
    if(app.policy.mode!=='direct')for(const role of roles)if(!circuit.failureRole||role===circuit.failureRole)this.cooldown.set(providerCooldownKey(role,circuit.providers[role]),this.now()+60000);
    app.error=reason;app.lastFailure={at:this.now(),circuit:circuit.id,reason};this.log(`app ${app.id.slice(0,10)} circuit ${circuit.id}: ${reason}`);
    await this.publishApp(app).catch(e=>this.log(`route withdrawal: ${e.message}`));
    await circuit.close(reason);
  }
  async publishApp(app) {
    // Compute the current set when this write runs, not when it was queued.
    // A delayed successful probe can never republish a failed/withdrawn route.
    const operation=(this.publications.get(app.id)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const routes=!this.closed&&this.authorizationUntil(app.id)>this.now()?app.circuits.filter(c=>c.healthy&&!c.closed)
        .sort((a,b)=>Number(!!a.providers.public?.fallback)-Number(!!b.providers.public?.fallback))
        .map(c=>({circuit:c.id,address:c.address,port:443,transport:app.policy.mode==='direct'?'direct':'tuna-guarded-tcp',...(c.directPort?{directPort:c.directPort}:{}),...(c.providers.public?.fallback?{fallback:true}:{})})):[];
      await this.publish(app.id,routes);this.emit('change',this.status());
    });
    this.publications.set(app.id,operation);return operation;
  }
  enforceAdmission() {
    for(const app of this.apps.values()){
      const expiry=this.authorizationUntil(app.id);
      for(const circuit of app.circuits)circuit.admit(expiry);
      if(!expiry&&app.circuits.length)void this.withdraw(app,'authorization expired').catch(e=>this.log(e.message));
    }
  }
  async reconcile() {
    if(this.busy||this.closed)return;this.busy=true;
    const pending=[];
    try{
      this.enforceAdmission();const nodes=[...this.apps.values()].some(a=>a.policy.mode!=='direct')?await this.inventory():[];
      for(const app of this.apps.values()){
        const appNodes=app.policy.currency==='USDC'?tunaInventoryForLease(nodes,this.admission.leases.get(app.id),app.policy,this.now()):fallbackInventory(nodes,app.publicFallback);
        const checking=this.checkHealth(app,appNodes);
        if(this.reconcilingApps.has(app.id)){void checking.catch(e=>this.log(e.message));continue;}
        const operation=checking.then(()=>this.reconcileApp(app,appNodes)).catch(e=>{app.error=e.message;this.log(`app ${app.id.slice(0,10)}: ${e.message}`);})
          .finally(()=>this.reconcilingApps.delete(app.id));
        this.reconcilingApps.set(app.id,operation);pending.push(operation);
      }
    }finally{this.busy=false;}
    // Each app allocates and probes independently. A stalled provider cannot
    // prevent another app's health checks, repair, or route withdrawal.
    await Promise.all(pending);
  }
  checkHealth(app,nodes) {
    if(this.healthChecks.has(app.id))return this.healthChecks.get(app.id);
    const operation=(async()=>{
    if(app.policy.mode==='direct'){
      for(const circuit of [...app.circuits]){
        try{
          await this.directRuntime.refresh(circuit);circuit.admit(this.authorizationUntil(app.id));
          if(circuit.egressReady&&!circuit.healthy&&this.admission.proofs.get(app.id)?.ready===false)continue;
          if(this.now()-(circuit.checkedAt||0)>20000){await this.probe(app,circuit);circuit.checkedAt=this.now();circuit.healthy=true;await this.publishApp(app);}
        }catch(e){await this.fail(app,circuit,e.message);}
      }
      return;
    }
    // Recheck advertised identity, current price, exclusions and failure
    // domain metadata before keeping an existing allocation.
    for(const circuit of [...app.circuits]){
      const current=Object.fromEntries(roles.map(role=>[role,nodes.find(n=>n.identity===circuit.providers[role].identity)]));
      const eligible=roles.every(role=>current[role]&&providerAllowedForPolicy(current[role],app.policy,role,this.now()));
      if(!eligible||!sameProviders(current,circuit.providers))await this.fail(app,circuit,'provider no longer satisfies policy');
    }
    // End-to-end proof is required for the public route, not just a live
    // SOCKS connection or an SDK allocation event.
    for(const circuit of [...app.circuits])if(this.now()-(circuit.checkedAt||0)>20000){
      if(circuit.egressReady&&!circuit.healthy&&this.admission.proofs.get(app.id)?.ready===false)continue;
      try{const started=this.now();await this.probe(app,circuit);if(!app.circuits.includes(circuit)||circuit.closed)continue;circuit.checkedAt=this.now();circuit.probeFailures=0;circuit.healthy=true;await this.publishApp(app);void this.observe(withCarry(circuit.providers),{ok:true,latencyMs:this.now()-started}).catch(e=>this.log(e.message));}
      catch(e){
        if(!app.circuits.includes(circuit)||circuit.closed)continue;
        circuit.probeFailures=(circuit.probeFailures||0)+1;
        if(transientRouteError(e)&&circuit.probeFailures<ROUTE_PROBE_FAILURES){
          // Retry soon rather than after the full interval; the route stays published meanwhile.
          circuit.checkedAt=this.now()-20000+ROUTE_RETRY_MS;
          this.log(`app ${app.id.slice(0,10)} circuit ${circuit.id}: route probe ${circuit.probeFailures}/${ROUTE_PROBE_FAILURES} failed: ${e.message}`);
          continue;
        }
        await this.fail(app,circuit,`route verification failed: ${e.message}`);
      }
    }
    })().finally(()=>this.healthChecks.delete(app.id));
    this.healthChecks.set(app.id,operation);return operation;
  }
  async reconcileApp(app,nodes) {
    if(!this.authorizationUntil(app.id)){app.error='awaiting fresh chain and guest authorization';return;}
    if(app.policy.mode==='direct'){
      if(app.circuits.length){app.error=null;await this.publishApp(app);return;}
      let circuit;
      try{
        circuit=await this.directRuntime.start({deploymentId:app.id,names:app.names,policy:app.policy});
        circuit.admit(this.authorizationUntil(app.id));
        const bootstrap=app.startupEgress===true&&this.admission.proofs.get(app.id)?.ready===false;
        if(!bootstrap)await this.probe(app,circuit);
        if(this.closed||this.apps.get(app.id)!==app||!this.authorizationUntil(app.id)||circuit.closed)throw new Error('direct authorization changed');
        circuit.healthy=!bootstrap;circuit.egressReady=true;circuit.checkedAt=bootstrap?0:this.now();
        circuit.on('down',reason=>{void this.fail(app,circuit,reason).catch(e=>this.log(e.message));});
        app.circuits.push(circuit);app.error=null;await this.publishApp(app);
      }catch(e){await circuit?.close(e.message);app.error=e.message;await this.publishApp(app);}
      return;
    }
    if(app.circuits.length===2&&app.publicFallback&&!app.circuits.some(c=>c.providers.public.fallback)&&!app.policy.providers.public.prefer.length){
      // Restore the reserved fallback after an outage without tearing down both
      // working paths. First prove that a policy-valid replacement can be chosen.
      for(const keep of app.circuits){
        const candidate=selectCircuitProviders(app.policy,nodes,{locked:[keep.providers],cooldown:this.cooldown,now:this.now()});
        if(!candidate.ready||!candidate.circuits.some(p=>p.public.fallback))continue;
        const old=app.circuits.find(c=>c!==keep);app.circuits=app.circuits.filter(c=>c!==old);old.healthy=false;old.admit(0);
        await this.publishApp(app);await old.close('restoring configured fallback');break;
      }
    }
    if(app.circuits.length===2){app.error=null;await this.publishApp(app);return;}
    const choice=selectCircuitProviders(app.policy,nodes,{existing:app.circuits.map(c=>({...c.providers,healthy:c.healthy})),locked:app.circuits.map(c=>c.providers),occupiedPublic:new Set([...this.reservedPublic,...this.occupiedElsewhere,...[...this.apps.values()].filter(a=>a.policy.mode!=='direct').flatMap(a=>a.circuits.flatMap(c=>publicReservations(c.providers.public)))]),cooldown:this.cooldown,now:this.now()});
    if(!choice.ready){app.error=choice.reason;await this.publishApp(app);return;}
    const reserved=choice.circuits.filter(p=>!app.circuits.some(c=>sameProviders(c.providers,p))).flatMap(p=>publicReservations(p.public));
    for(const address of reserved)this.reservedPublic.add(address);
    try{
    for(const providers of choice.circuits){
      if(this.closed||this.apps.get(app.id)!==app||!this.authorizationUntil(app.id))return;
      if(app.circuits.some(c=>sameProviders(c.providers,providers)))continue;
      if(app.circuits.some(c=>!independentCircuits(c.providers,providers,app.policy.diversity)))continue;
      const slot=[0,1].find(n=>!app.circuits.some(c=>c.slot===n));if(slot===undefined)break;
      let circuit;const started=this.now();
      try{
        circuit=await this.runtime.start({deploymentId:app.id,names:app.names,providers,wallets:app.wallets[slot],maxPrice:app.policy.maxPrice,policy:app.policy});
        if(this.closed||this.apps.get(app.id)!==app||!this.authorizationUntil(app.id))throw new Error('authorization changed while allocating');
        circuit.admit(this.authorizationUntil(app.id));
        const bootstrap=app.startupEgress===true&&this.admission.proofs.get(app.id)?.ready===false;
        if(!bootstrap)await this.probe(app,circuit);
        if(circuit.closed||!this.authorizationUntil(app.id))throw new Error('circuit failed during verification');
        void this.observe(withCarry(providers),{ok:true,latencyMs:this.now()-started}).catch(e=>this.log(e.message));
        for(const role of roles)this.strikes.delete(providerCooldownKey(role,providers[role]));
        circuit.slot=slot;circuit.healthy=!bootstrap;circuit.egressReady=true;circuit.checkedAt=bootstrap?0:this.now();
        circuit.on('down',reason=>{void this.fail(app,circuit,reason).catch(e=>this.log(e.message));});
        app.circuits.push(circuit);await this.publishApp(app);
      }catch(e){
        if(!circuit||!app.circuits.includes(circuit)){
          // An allocation timeout cannot say whether the guard or the public
          // node failed; both are charged, and successes clear either side.
          void this.observe(withCarry(providers),{ok:false,role:e.providerRole}).catch(error=>this.log(error.message));
          if(e.providerRole==='public')void this.observe({carry:providers.guard},{ok:false,role:'carry'}).catch(error=>this.log(error.message));
        }
        // A provider that keeps failing allocation waits longer each time
        // (60 s doubling to 30 min) so the search moves on to the rest of the
        // network instead of spending every attempt on the same few nodes. An
        // unattributed timeout escalates only the public side; a success resets.
        for(const role of roles)if(!e.providerRole||role===e.providerRole){
          const key=providerCooldownKey(role,providers[role]),escalate=role===(e.providerRole||'public');
          const n=escalate?(this.strikes.get(key)||0)+1:1;if(escalate)this.strikes.set(key,n);
          this.cooldown.set(key,this.now()+Math.min(60000*2**(n-1),COOLDOWN_MAX_MS));
        }
        if(circuit){if(app.circuits.includes(circuit))await this.fail(app,circuit,e.message);else await circuit.close(e.message);}app.error=e.message;this.log(`app ${app.id.slice(0,10)}: ${e.message}`);
      }
    }
    app.error=app.circuits.length===2?null:app.error||'second independent circuit unavailable';
    }finally{for(const address of reserved)this.reservedPublic.delete(address);}
  }
  status() {return [...this.apps.values()].map(app=>({deploymentId:app.id,transport:app.policy.mode==='direct'?'direct':'tuna',ready:app.circuits.length===app.policy.routes&&app.circuits.every(c=>c.healthy)&&!!this.authorizationUntil(app.id),
    error:app.error,lastFailure:app.lastFailure||null,circuits:app.circuits.map(c=>({id:c.id,address:c.address,port:c.port,...(c.directPort?{directPort:c.directPort}:{}),fallback:!!c.providers.public?.fallback,healthy:c.healthy,egress:c.egress?.split('@').pop()}))}));}
  async close() {this.closed=true;const withdrawing=[...this.apps.values()].map(app=>this.withdraw(app,'manager stopped'));await Promise.all([...withdrawing,this.runtime.close?.(),this.directRuntime?.close()]);}
}
