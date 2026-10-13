import {DurableState} from './durable-state.mjs';

// The native guest manager resolves CID -> deployment itself. This file never
// admits a caller-supplied app id, and is unusable after the manager's heartbeat.
export class EgressMap {
  constructor({directory,manager,dns,now=Date.now,log=()=>{}}) {
    if(!Array.isArray(dns)||!dns.length||dns.length>4)throw new Error('explicit app DNS resolvers required');
    Object.assign(this,{manager,dns,now,log});this.state=new DurableState(directory,{inPlace:true});this.listed=new Map();
  }
  async write() {
    const now=this.now(),apps={};let expiresAt=now+30000;
    const why=new Map();
    for(const app of this.manager.apps.values()){
      const until=this.manager.authorizationUntil(app.id);if(until<=now){why.set(app.id,'authorization lapsed (lease or guest proof)');continue;}
      const proxies=app.circuits.filter(c=>(c.healthy||(app.startupEgress===true&&c.egressReady))&&!c.closed&&c.egress).map(c=>c.egress);
      if(proxies.length){apps[app.id]={proxies,dns:this.dns};expiresAt=Math.min(expiresAt,until);}
      else why.set(app.id,`no healthy egress circuit (${app.circuits.length} circuit(s))`);
    }
    // An app's egress is refused while it is out of this file ("refused:admit" in the shield log): say when it leaves,
    // why, and when it is back - a request failing on a new connection was otherwise unexplained (2026-10-13)
    for(const id of new Set([...this.listed.keys(),...why.keys(),...Object.keys(apps)])){
      const was=this.listed.get(id),is=!!apps[id];
      if(was===true&&!is)this.log(`app ${id.slice(0,10)} egress OFF: ${why.get(id)||'no longer configured'}`);
      if(was===false&&is)this.log(`app ${id.slice(0,10)} egress back`);
      if(this.manager.apps.has(id))this.listed.set(id,is);else this.listed.delete(id);
    }
    const map={version:1,expiresAt,apps};await this.state.set('egress-routes',map);return map;
  }
}
