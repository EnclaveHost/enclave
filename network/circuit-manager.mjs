import {EventEmitter} from 'node:events';
import {validateCircuitPolicy,selectCircuitProviders,providerAllowed,nknAmount,independentCircuits} from './circuit-policy.mjs';
import {recordHash} from './route-record.mjs';
import {validateAppNames} from './app-ingress.mjs';

const roles=['guard','public','egress'];
const sameProviders=(a,b)=>roles.every(role=>a[role].identity===b[role].identity&&a[role].address===b[role].address&&a[role].beneficiary===b[role].beneficiary&&a[role].asn===b[role].asn);
export class CircuitManager extends EventEmitter {
  constructor({runtime,admission,inventory,wallets,probe,publish,observe=async()=>{},now=Date.now,log=()=>{}}) {
    super();Object.assign(this,{runtime,admission,inventory,wallets,probe,publish,observe,now,log});this.apps=new Map();this.cooldown=new Map();this.closed=false;this.busy=false;this.publications=new Map();this.reconcilingApps=new Map();this.reservedPublic=new Set();this.healthChecks=new Map();
  }
  async configure(apps) {
    const next=new Map(),walletOwners=new Map();
    for(const app of apps){
      const policy=validateCircuitPolicy(app.policy),id=policy.deploymentId;
      if(next.has(id)||!Array.isArray(app.names)||!app.names.length)throw new Error('duplicate app or missing names');
      validateAppNames(id,app.names);
      const wallets=await this.wallets(id);let total=0n;
      if(!Array.isArray(wallets)||wallets.length!==2)throw new Error('two independently funded circuit slots required');
      for(const slot of wallets)for(const role of roles){
        const wallet=slot[role];
        if(!wallet||walletOwners.has(wallet.address))throw new Error('wallet identity reused across apps, roles or circuits');
        walletOwners.set(wallet.address,id);total+=nknAmount(wallet.fundedNkn);
      }
      if(total>nknAmount(policy.budgetNkn))throw new Error('funded wallets exceed app budget');
      const fingerprint=recordHash({policy,names:app.names});
      const old=this.apps.get(id);
      next.set(id,old?.fingerprint===fingerprint?old:{...app,policy,id,wallets,fingerprint,circuits:[],error:'starting'});
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
    void this.observe(circuit.providers,{ok:false,role:circuit.failureRole}).catch(e=>this.log(e.message));
    circuit.healthy=false;app.circuits=app.circuits.filter(c=>c!==circuit);circuit.admit(0);
    // A failure cannot cause an immediate retry of the same set of providers.
    for(const role of roles)if(!circuit.failureRole||role===circuit.failureRole)this.cooldown.set(role+':'+circuit.providers[role].identity,this.now()+60000);
    app.error=reason;app.lastFailure={at:this.now(),circuit:circuit.id,reason};this.log(`app ${app.id.slice(0,10)} circuit ${circuit.id}: ${reason}`);
    await this.publishApp(app).catch(e=>this.log(`route withdrawal: ${e.message}`));
    await circuit.close(reason);
  }
  async publishApp(app) {
    // Compute the current set when this write runs, not when it was queued.
    // A delayed successful probe can never republish a failed/withdrawn route.
    const operation=(this.publications.get(app.id)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const routes=!this.closed&&this.authorizationUntil(app.id)>this.now()?app.circuits.filter(c=>c.healthy&&!c.closed).map(c=>({circuit:c.id,address:c.address,port:443,transport:'tuna-guarded-tcp'})):[];
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
      this.enforceAdmission();const nodes=await this.inventory();
      for(const app of this.apps.values()){
        const checking=this.checkHealth(app,nodes);
        if(this.reconcilingApps.has(app.id)){void checking.catch(e=>this.log(e.message));continue;}
        const operation=checking.then(()=>this.reconcileApp(app,nodes)).catch(e=>{app.error=e.message;this.log(`app ${app.id.slice(0,10)}: ${e.message}`);})
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
    // Recheck advertised identity, current price, exclusions and failure
    // domain metadata before keeping an existing allocation.
    for(const circuit of [...app.circuits]){
      const current=Object.fromEntries(roles.map(role=>[role,nodes.find(n=>n.identity===circuit.providers[role].identity)]));
      const eligible=roles.every(role=>current[role]&&providerAllowed(current[role],app.policy.providers[role],app.policy.maxPrice,this.now()));
      if(!eligible||!sameProviders(current,circuit.providers))await this.fail(app,circuit,'provider no longer satisfies policy');
    }
    // End-to-end proof is required for the public route, not just a live
    // SOCKS connection or an SDK allocation event.
    for(const circuit of [...app.circuits])if(this.now()-(circuit.checkedAt||0)>20000){
      try{const started=this.now();await this.probe(app,circuit);if(!app.circuits.includes(circuit)||circuit.closed)continue;circuit.checkedAt=this.now();void this.observe(circuit.providers,{ok:true,latencyMs:this.now()-started}).catch(e=>this.log(e.message));}
      catch(e){await this.fail(app,circuit,`route verification failed: ${e.message}`);}
    }
    })().finally(()=>this.healthChecks.delete(app.id));
    this.healthChecks.set(app.id,operation);return operation;
  }
  async reconcileApp(app,nodes) {
    if(!this.authorizationUntil(app.id)){app.error='awaiting fresh chain and guest authorization';return;}
    if(app.circuits.length===2){app.error=null;await this.publishApp(app);return;}
    const choice=selectCircuitProviders(app.policy,nodes,{existing:app.circuits.map(c=>({...c.providers,healthy:c.healthy})),locked:app.circuits.map(c=>c.providers),occupiedPublic:new Set([...this.reservedPublic,...[...this.apps.values()].flatMap(a=>a.circuits.map(c=>c.address))]),cooldown:this.cooldown,now:this.now()});
    if(!choice.ready){app.error=choice.reason;await this.publishApp(app);return;}
    const reserved=choice.circuits.filter(p=>!app.circuits.some(c=>sameProviders(c.providers,p))).map(p=>p.public.address);
    for(const address of reserved)this.reservedPublic.add(address);
    try{
    for(const providers of choice.circuits){
      if(this.closed||this.apps.get(app.id)!==app||!this.authorizationUntil(app.id))return;
      if(app.circuits.some(c=>sameProviders(c.providers,providers)))continue;
      if(app.circuits.some(c=>!independentCircuits(c.providers,providers,app.policy.diversity)))continue;
      const slot=[0,1].find(n=>!app.circuits.some(c=>c.slot===n));if(slot===undefined)break;
      let circuit;const started=this.now();
      try{
        circuit=await this.runtime.start({deploymentId:app.id,names:app.names,providers,wallets:app.wallets[slot],maxPrice:app.policy.maxPrice});
        if(this.closed||this.apps.get(app.id)!==app||!this.authorizationUntil(app.id))throw new Error('authorization changed while allocating');
        circuit.admit(this.authorizationUntil(app.id));
        await this.probe(app,circuit);
        if(circuit.closed||!this.authorizationUntil(app.id))throw new Error('circuit failed during verification');
        void this.observe(providers,{ok:true,latencyMs:this.now()-started}).catch(e=>this.log(e.message));
        circuit.slot=slot;circuit.healthy=true;circuit.checkedAt=this.now();
        circuit.on('down',reason=>{void this.fail(app,circuit,reason).catch(e=>this.log(e.message));});
        app.circuits.push(circuit);await this.publishApp(app);
      }catch(e){
        if(!circuit||!app.circuits.includes(circuit))void this.observe(providers,{ok:false,role:e.providerRole}).catch(error=>this.log(error.message));
        for(const role of roles)if(!e.providerRole||role===e.providerRole)this.cooldown.set(role+':'+providers[role].identity,this.now()+60000);
        if(circuit){if(app.circuits.includes(circuit))await this.fail(app,circuit,e.message);else await circuit.close(e.message);}app.error=e.message;this.log(`app ${app.id.slice(0,10)}: ${e.message}`);
      }
    }
    app.error=app.circuits.length===2?null:app.error||'second independent circuit unavailable';
    }finally{for(const address of reserved)this.reservedPublic.delete(address);}
  }
  status() {return [...this.apps.values()].map(app=>({deploymentId:app.id,ready:app.circuits.length===2&&app.circuits.every(c=>c.healthy)&&!!this.authorizationUntil(app.id),
    error:app.error,lastFailure:app.lastFailure||null,circuits:app.circuits.map(c=>({id:c.id,address:c.address,port:c.port,healthy:c.healthy,egress:c.egress}))}));}
  async close() {this.closed=true;const withdrawing=[...this.apps.values()].map(app=>this.withdraw(app,'manager stopped'));await Promise.all([...withdrawing,this.runtime.close?.()]);}
}
