p='network/wg-provider/provider.mjs'; s=open(p).read()
def rep(old,new):
    global s
    assert s.count(old)==1,(old,s.count(old)); s=s.replace(old,new)
# constructor: a serial queue for host-service mutations
rep("""  this.accepting=true;           // false when over the transfer budget or unqualified: no new peers
 }""","""  this.accepting=true;           // false when over the transfer budget or unqualified: no new peers
  this.serviceQueue=Promise.resolve();   // host-service grants and revokes mutate one at a time (service(), revoke())
 }
 // run fn after every earlier host-service mutation settled (its own outcome is returned; a failure never blocks the next)
 serial(fn){const run=this.serviceQueue.then(fn,fn);this.serviceQueue=run.catch(()=>{});return run;}
 // the replay check and its consumption in ONE synchronous step (no await between): a signed envelope is used once,
 // however many copies race through the reads before it
 consumeNonce(nonce,now){
  for(const [n,exp] of this.nonces)if(exp<now)this.nonces.delete(n);
  if(this.nonces.has(nonce))throw new Error('replayed request');
  this.nonces.set(nonce,now+2*REQUEST_MAX_AGE_MS);
 }""")
# service(): reads first (concurrently with other hosts), then a serialized section that consumes the nonce and mutates
rep("""  const host=await this.hosts(r.runner);
  if(!host||!host.active||String(host.operator).toLowerCase()!==signer)throw new Error('the request is not from an active registered host');
  await this.admitHost(r.runner);
  this.nonces.set(r.nonce,now+2*REQUEST_MAX_AGE_MS);
  let peer=this.peers.get(r.wgPublicKey);
  if(peer&&(peer.role!=='service'||peer.runner!==r.runner||peer.deploymentId!==r.deploymentId))throw new Error('key is held by another peer');""","""  const host=await this.hosts(r.runner);
  if(!host||!host.active||String(host.operator).toLowerCase()!==signer)throw new Error('the request is not from an active registered host');
  await this.admitHost(r.runner);
  return this.serial(()=>this.grantService(r,now));
 }
 async grantService(r,now){
  const hs=this.config.hostServices;
  if(!hs)throw new Error('this provider does not carry host services');
  this.consumeNonce(r.nonce,now);
  let peer=this.peers.get(r.wgPublicKey);
  if(peer&&(peer.role!=='service'||peer.runner!==r.runner||peer.deploymentId!==r.deploymentId))throw new Error('key is held by another peer');""")
# revoke(): the same split
rep("""  for(const [n,exp] of this.nonces)if(exp<now)this.nonces.delete(n);
  if(this.nonces.has(r.nonce))throw new Error('replayed revoke request');
  if(typeof envelope.signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(envelope.signature))throw new Error('host signature required');""","""  for(const [n,exp] of this.nonces)if(exp<now)this.nonces.delete(n);
  if(this.nonces.has(r.nonce))throw new Error('replayed request');
  if(typeof envelope.signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(envelope.signature))throw new Error('host signature required');""")
rep("""  if(!host||String(host.operator).toLowerCase()!==signer)throw new Error('the request is not from the host\\'s registry operator');
  this.nonces.set(r.nonce,now+2*REQUEST_MAX_AGE_MS);
  const peer=this.peers.get(r.wgPublicKey);
  if(!peer||peer.runner!==r.runner||!(peer.role==='service'||peer.control))throw new Error('no peer of this host holds that key');
  await this.remove(peer,'revoked by the host');await this.sync();
  return {revoked:true,role:peer.role,clientAddress:peer.address};
 }""","""  if(!host||String(host.operator).toLowerCase()!==signer)throw new Error('the request is not from the host\\'s registry operator');
  return this.serial(async()=>{
   this.consumeNonce(r.nonce,now);
   const peer=this.peers.get(r.wgPublicKey);
   if(!peer||peer.runner!==r.runner||!(peer.role==='service'||peer.control))throw new Error('no peer of this host holds that key');
   await this.remove(peer,'revoked by the host');await this.sync();
   return {revoked:true,role:peer.role,clientAddress:peer.address};
  });
 }""")
# names(): reserve only the configured service namespace and its derived shapes; app-zone behaviour unchanged
rep("""  const svc=this.config.hostServices?.zone;
  // a host's service names (and the zone they live in) are never an app's: no custom domain may take one
  const custom=(await this.domains(id).catch(()=>[])).filter(n=>typeof n==='string'&&n.length<=253&&/^[a-z0-9.-]+$/.test(n)&&!n.endsWith('.'+zone)&&
   !(svc&&(n===svc||n.endsWith('.'+svc)))&&!isHostServiceName(n));""","""  const svc=this.config.hostServices?.zone;
  // a host's service names are never an app's: no custom domain of the service shape IN the service zone, nor (a
  // dedicated service zone) any name in it. Outside it, a customer's verified domain of any shape is untouched.
  const custom=(await this.domains(id).catch(()=>[])).filter(n=>typeof n==='string'&&n.length<=253&&/^[a-z0-9.-]+$/.test(n)&&!n.endsWith('.'+zone)&&
   !(svc&&isHostServiceName(n,svc))&&!(svc&&svc!==zone&&(n===svc||n.endsWith('.'+svc))));""")
rep(""" route(name){
  name=String(name||'').toLowerCase();let best=null;const service=isHostServiceName(name);""",""" route(name){
  name=String(name||'').toLowerCase();let best=null;const svc=this.config.hostServices?.zone,service=!!svc&&isHostServiceName(name,svc);""")
rep(""" // name -> tunnel address of the newest ingress peer holding it. A host-service name comes ONLY from a service peer (and
 // only one whose derived names hold it); any other name never from a service peer.""",""" // name -> tunnel address of the newest ingress peer holding it. A host-service name (the service shape in the configured
 // service zone) comes ONLY from a service peer whose derived names hold it; any other name never from a service peer.""")
# sweep: structured statuses of the platform host policy (platform-host-policy.mjs judgeHost / host-policy-runtime decide)
rep("""  let d;try{d=(await this.hostAdmission([p.runner]))?.[p.runner];}catch{return;}
  if(d&&d.admit===false&&(d.status==='inactive'||/^(banned by platform policy|not admitted by platform allowlist)/.test(d.reason||'')))await this.remove(p,'platform host policy: '+d.reason);
 }""","""  let d;try{d=(await this.hostAdmission([p.runner]))?.[p.runner];}catch{return;}
  if(definiteRefusal(d))await this.remove(p,'platform host policy: '+(d.reason||d.status));
 }""")
rep("""export function validateRevokeRequest(r,now=Date.now()){""","""// A platform host policy decision that DEFINITELY refuses a host (the admin's ban, an allowlist miss, an inactive registry
// entry), by the decision's structured status: judgeHost judged the host against an ACCEPTED policy ('current',
// 'stale-grace', 'stale') or decide() found the entry inactive. Every other refusal (no policy accepted, behind the anchor,
// authority unread or rotated, torn anchor, unanchored, no decision) is the node not knowing, and keeps an existing peer.
// The single non-admin judgement - a STALE policy refusing a host it never admitted - is excluded by judgeHost's own reason.
export const STALE_NEW_HOST='platform host policy is stale: new hosts are refused until a current policy is fetched';
export function definiteRefusal(d){
 if(!d||d.admit!==false)return false;
 if(d.status==='inactive'||d.status==='current'||d.status==='stale-grace')return true;
 return d.status==='stale'&&d.reason!==STALE_NEW_HOST;
}

export function validateRevokeRequest(r,now=Date.now()){""")
open(p,'w').write(s)
