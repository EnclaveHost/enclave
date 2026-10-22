p='network/wg-provider/provider.mjs'; s=open(p).read()
def rep(old,new,count=1):
    global s
    assert s.count(old)==count, (old, s.count(old))
    s=s.replace(old,new)
rep("""  await this.prune();
  await this.sync();
 }
 async sync(){""","""  await this.prune();
  await this.observeHandshakes();
  await this.sync();
 }
 async sync(){""")
rep(""" // A qualification checker's own peer: exit ingress for one random probe name""",""" // A host's own PUBLIC SERVICE roles (work/host-service-transport-20261021): an exit-interface peer with ingress for exactly
 // the names derived from the host's full registry id (host-service-names.mjs), never names it asks for, never an app's,
 // never egress. Admitted like control(): an active registry entry whose operator signed; AND the platform host policy's
 // explicit admit (bans, allowlist) unless the operator wrote platformHostPolicy "off" (development only: the transport
 // profile refuses it). At most two per host (handover), at most hostServices.maxHosts hosts. Removed on revoke, expiry,
 // deactivation or a definite policy refusal (sweep).
 async service(r,signer,now){
  const hs=this.config.hostServices;
  if(!hs)throw new Error('this provider does not carry host services');
  if(!this.config.roles.includes('ingress'))throw new Error('this provider does not offer ingress');
  const host=await this.hosts(r.runner);
  if(!host||!host.active||String(host.operator).toLowerCase()!==signer)throw new Error('the request is not from an active registered host');
  await this.admitHost(r.runner);
  this.nonces.set(r.nonce,now+2*REQUEST_MAX_AGE_MS);
  let peer=this.peers.get(r.wgPublicKey);
  if(peer&&(peer.role!=='service'||peer.runner!==r.runner||peer.deploymentId!==r.deploymentId))throw new Error('key is held by another peer');
  if(!peer){
   if(this.peers.size>=MAX_PEERS)throw new Error('provider is full');
   const carried=new Set([...this.peers.values()].filter(p=>p.role==='service').map(p=>p.runner));
   if(!carried.has(r.runner)&&carried.size>=(hs.maxHosts||MAX_SERVICE_HOSTS))throw new Error('this provider carries its maximum number of host services');
   const same=[...this.peers.values()].filter(p=>p.role==='service'&&p.runner===r.runner).sort((a,b)=>a.createdAt-b.createdAt);
   while(same.length>=2)await this.remove(same.shift(),'replaced');
   peer={key:r.wgPublicKey,role:'service',deploymentId:r.deploymentId,runner:r.runner,address:this.allocate('exit'),createdAt:now,service:true};
  }
  const names=Object.values(hostServiceNames(r.runner,hs.zone));
  Object.assign(peer,{egress:false,ingress:true,names,grantedAt:now,expiresAt:Math.min(r.expiresAt,now+PEER_TTL_MS)});
  this.peers.set(peer.key,peer);await this.kernel.setPeer(peer);await this.sync();await this.persist();
  const grant={version:1,providerId:this.config.providerId,role:'service',deploymentId:r.deploymentId,clientPublicKey:r.wgPublicKey,
   providerPublicKey:this.config.exitKey,endpoint:`${this.config.publicAddress}:${this.config.ports.exit}`,
   clientAddress:peer.address,serverAddress:'10.77.0.1',names,issuedAt:now,expiresAt:peer.expiresAt};
  return {grant,signature:await this.signer.signMessage({message:grantMessage(grant)})};
 }
 // the platform host policy for a host-service grant: only an explicit admit passes; a refusal or an unreadable policy refuses
 async admitHost(id){
  if(!this.hostAdmission){
   if(this.config.hostServices?.platformHostPolicy==='off')return;
   throw new Error('host services need the platform host policy (or platformHostPolicy "off", written explicitly)');
  }
  const d=(await this.hostAdmission([id]))?.[id];
  if(d?.admit!==true)throw new Error('platform host policy: '+(d?.reason||'no decision'));
 }
 // A host withdraws its own service or control peer at once (signed by the host's registry operator). Never an app's peer,
 // never another host's: the key must be held by a host-owned peer of exactly that runner.
 async revoke(envelope){
  const now=this.now();
  const r=validateRevokeRequest(envelope?.request,now);
  if(r.providerId!==this.config.providerId)throw new Error('request is for another provider');
  for(const [n,exp] of this.nonces)if(exp<now)this.nonces.delete(n);
  if(this.nonces.has(r.nonce))throw new Error('replayed revoke request');
  if(typeof envelope.signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(envelope.signature))throw new Error('host signature required');
  const signer=(await recoverMessageAddress({message:revokeMessage(r),signature:envelope.signature})).toLowerCase();
  const host=await this.hosts(r.runner);
  if(!host||String(host.operator).toLowerCase()!==signer)throw new Error('the request is not from the host\\'s registry operator');
  this.nonces.set(r.nonce,now+2*REQUEST_MAX_AGE_MS);
  const peer=this.peers.get(r.wgPublicKey);
  if(!peer||peer.runner!==r.runner||!(peer.role==='service'||peer.control))throw new Error('no peer of this host holds that key');
  await this.remove(peer,'revoked by the host');await this.sync();
  return {revoked:true,role:peer.role,clientAddress:peer.address};
 }
 // The ONE host peer that receives UDP/TCP 53 sent to this provider's public address (kernel dns_dnat), or null:
 // unexpired 'service' peers of hosts the operator pinned (hostServices.dns.hosts: the app zone's authority is the
 // operator's decision, not any registered host's), alive (a WireGuard handshake, or the grant itself, within staleMs),
 // ranked by sha256(providerId|hostId) - the same inputs give the same host on every sync; when it goes, the next.
 dnsTarget(){
  const dns=this.config.hostServices?.dns;if(!dns?.hosts?.length)return null;
  const now=this.now(),pins=new Set(dns.hosts.map(h=>String(h).toLowerCase())),stale=dns.staleMs||DNS_STALE_MS;
  const rank=p=>createHash('sha256').update(`${this.config.providerId}|${p.runner}`).digest('hex');
  let best=null,bestRank='';
  for(const p of this.peers.values()){
   if(p.role!=='service'||p.expiresAt<=now||!pins.has(p.runner))continue;
   if(now-Math.max(p.grantedAt||p.createdAt,p.lastHandshake||0)>stale)continue;
   const k=rank(p);if(!best||k>bestRank||(k===bestRank&&p.createdAt>best.createdAt)){best=p;bestRank=k;}
  }
  return best?.address||null;
 }
 // A qualification checker's own peer: exit ingress for one random probe name""")
rep("""  const custom=(await this.domains(id).catch(()=>[])).filter(n=>typeof n==='string'&&n.length<=253&&/^[a-z0-9.-]+$/.test(n)&&!n.endsWith('.'+zone));""","""  const svc=this.config.hostServices?.zone;
  // a host's service names (and the zone they live in) are never an app's: no custom domain may take one
  const custom=(await this.domains(id).catch(()=>[])).filter(n=>typeof n==='string'&&n.length<=253&&/^[a-z0-9.-]+$/.test(n)&&!n.endsWith('.'+zone)&&
   !(svc&&(n===svc||n.endsWith('.'+svc)))&&!isHostServiceName(n));""")
rep("""   if(p.role==='probe')continue;
   // a peer goes only""","""   if(p.role==='probe')continue;
   if(p.role==='service'){await this.sweepService(p);continue;}
   // a peer goes only""")
rep(""" async sync(){
  const peers=[...this.peers.values()];""",""" // a service peer goes only on a DEFINITE answer, as above: its host left the registry or was deactivated (the admin's
 // registry ban), or the platform host policy explicitly refuses it (ban, allowlist miss); an unreadable answer keeps it
 async sweepService(p){
  const hs=this.config.hostServices;
  if(!hs)return this.remove(p,'host services no longer offered');
  let host;try{host=await this.hosts(p.runner);}catch{return;}
  if(!host||!host.active)return this.remove(p,'host no longer registered');
  if(!this.hostAdmission){if(hs.platformHostPolicy!=='off')await this.remove(p,'platform host policy not configured');return;}
  let d;try{d=(await this.hostAdmission([p.runner]))?.[p.runner];}catch{return;}
  if(d&&d.admit===false&&(d.status==='inactive'||/^(banned by platform policy|not admitted by platform allowlist)/.test(d.reason||'')))await this.remove(p,'platform host policy: '+d.reason);
 }
 // WireGuard's own last handshake per peer (kernel stats), for the DNS liveness rule; a failed read changes nothing
 async observeHandshakes(){
  if(!this.config.hostServices?.dns?.hosts?.length||!this.kernel.stats)return;
  let stats;try{stats=await this.kernel.stats();}catch{return;}
  for(const p of this.peers.values())if(p.role==='service'&&stats[p.key]?.lastHandshake>0)p.lastHandshake=stats[p.key].lastHandshake;
 }
 async sync(){
  const peers=[...this.peers.values()];""")
rep("""   targets:await this.targets(),     // [{address, ports:{exit,control}}] of qualified providers a guard may reach
  });""","""   targets:await this.targets(),     // [{address, ports:{exit,control}}] of qualified providers a guard may reach
   ...(this.config.hostServices?.dns?.hosts?.length?{dns:this.dnsTarget()}:{}),   // the one host peer receiving UDP/TCP 53, or null
  });""")
rep(""" // name -> tunnel address of the newest ingress peer holding it
 route(name){
  name=String(name||'').toLowerCase();let best=null;
  for(const p of this.peers.values())if(p.role!=='guard'&&p.ingress&&p.expiresAt>this.now()&&p.names.includes(name)&&(!best||p.createdAt>best.createdAt))best=p;
  return best?.address||null;
 }""",""" // name -> tunnel address of the newest ingress peer holding it. A host-service name comes ONLY from a service peer (and
 // only one whose derived names hold it); any other name never from a service peer.
 route(name){
  name=String(name||'').toLowerCase();let best=null;const service=isHostServiceName(name);
  for(const p of this.peers.values())if(p.role!=='guard'&&p.ingress&&p.expiresAt>this.now()&&(p.role==='service')===service&&p.names.includes(name)&&(!best||p.createdAt>best.createdAt))best=p;
  return best?.address||null;
 }""")
rep(""" status(){return {providerId:this.config.providerId,accepting:this.accepting,peers:{guard:[...this.peers.values()].filter(p=>p.role==='guard').length,exit:[...this.peers.values()].filter(p=>p.role==='exit').length}};}""",""" status(){return {providerId:this.config.providerId,accepting:this.accepting,peers:{guard:[...this.peers.values()].filter(p=>p.role==='guard').length,exit:[...this.peers.values()].filter(p=>p.role==='exit').length,
  ...(this.config.hostServices?{service:[...this.peers.values()].filter(p=>p.role==='service').length}:{})},...(this.config.hostServices?.dns?.hosts?.length?{dnsTarget:this.dnsTarget()}:{})};}""")
open(p,'w').write(s)
