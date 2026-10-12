// Runs TUNA (policy v2-v4, CircuitManager) and the Enclave network (policy v5, EnclaveNetworkManager) side by side
// under one admission gate, one route publisher and one egress map, so a host can move apps one at a time
// (docs/design/enclave-network.md, rollout). An app is in exactly one of them, chosen by its policy version.
import {EventEmitter} from 'node:events';
export class CompositeManager extends EventEmitter {
 constructor({tuna,network}){super();this.tuna=tuna;this.network=network;for(const m of [tuna,network])m?.on?.('change',()=>this.emit('change',this.status()));}
 get managers(){return [this.tuna,this.network].filter(Boolean);}
 get apps(){const all=new Map();for(const m of this.managers)for(const [k,v] of m.apps)all.set(k,v);return all;}
 get closed(){return this.managers.every(m=>m.closed);}
 set occupiedElsewhere(v){if(this.tuna)this.tuna.occupiedElsewhere=v;}
 owner(app){return app?.policy?.version===5?this.network:this.tuna;}
 async configure(apps){
  const v5=apps.filter(a=>a.policy?.version===5),rest=apps.filter(a=>a.policy?.version!==5);
  if(v5.length&&!this.network)throw new Error('the Enclave network is not configured on this host');
  if(rest.length&&!this.tuna)throw new Error('TUNA is not configured on this host');
  // An app moving between them is withdrawn from the old one first (configure drops what it is no longer given).
  if(this.tuna)await this.tuna.configure(rest);
  if(this.network)await this.network.configure(v5);
 }
 authorizationUntil(id){for(const m of this.managers)if(m.apps.has(id))return m.authorizationUntil(id);return this.managers[0]?.authorizationUntil(id)||0;}
 enforceAdmission(){for(const m of this.managers)m.enforceAdmission();}
 async reconcile(){await Promise.all(this.managers.map(m=>m.reconcile()));}
 publishApp(app){const m=this.owner(app);return m?m.publishApp(app):Promise.resolve();}
 status(){return this.managers.flatMap(m=>m.status());}
 async close(){await Promise.all(this.managers.map(m=>m.close()));}
}
