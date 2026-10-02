import {DurableState} from './durable-state.mjs';

// The native guest manager resolves CID -> deployment itself. This file never
// admits a caller-supplied app id, and is unusable after the manager's heartbeat.
export class EgressMap {
  constructor({directory,manager,dns,now=Date.now}) {
    if(!Array.isArray(dns)||!dns.length||dns.length>4)throw new Error('explicit app DNS resolvers required');
    Object.assign(this,{manager,dns,now});this.state=new DurableState(directory);
  }
  async write() {
    const now=this.now(),apps={};let expiresAt=now+30000;
    for(const app of this.manager.apps.values()){
      const until=this.manager.authorizationUntil(app.id);if(until<=now)continue;
      const proxies=app.circuits.filter(c=>c.healthy&&!c.closed&&c.egress).map(c=>c.egress);
      if(proxies.length){apps[app.id]={proxies,dns:this.dns};expiresAt=Math.min(expiresAt,until);}
    }
    const map={version:1,expiresAt,apps};await this.state.set('egress-routes',map);return map;
  }
}
