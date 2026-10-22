p='network/wg-provider/provider.mjs'; s=open(p).read()
def rep(old,new):
    global s
    assert s.count(old)==1,(old,s.count(old)); s=s.replace(old,new)
rep(""" constructor({config,signer,kernel,leases,hosts=async()=>null,hostAdmission=null,verifyOwner,policyMemory,currentPolicy=async()=>null,domains,targets=async()=>[],store=null,now=Date.now,log=()=>{}}){
  Object.assign(this,{config,signer,kernel,leases,hosts,hostAdmission,verifyOwner,policyMemory,currentPolicy,domains,targets,store,now,log});""",""" // dnsProbe(address) -> true|false: the pinned host's DNS role answers through its tunnel (dns-probe.mjs); without it no
 // host ever receives DNS 53 (a handshake alone is not DNS)
 constructor({config,signer,kernel,leases,hosts=async()=>null,hostAdmission=null,dnsProbe=null,verifyOwner,policyMemory,currentPolicy=async()=>null,domains,targets=async()=>[],store=null,now=Date.now,log=()=>{}}){
  Object.assign(this,{config,signer,kernel,leases,hosts,hostAdmission,dnsProbe,verifyOwner,policyMemory,currentPolicy,domains,targets,store,now,log});""")
# m3: restore re-derives service names from the current zone (or drops them when host services are no longer offered)
rep("""  for(const p of saved?.peers||[]){
   if(!p||p.expiresAt<=now||!/^10\\.7[78]\\./.test(p.address||''))continue;""","""  for(const p of saved?.peers||[]){
   if(!p||p.expiresAt<=now||!/^10\\.7[78]\\./.test(p.address||''))continue;
   // a service peer's names follow THIS run's configuration, never the saved ones (a changed zone; host services withdrawn)
   if(p.role==='service'){if(!this.config.hostServices)continue;try{p.names=Object.values(hostServiceNames(p.runner,this.config.hostServices.zone));}catch{continue;}p.dnsOk=false;}""")
# B5: eligibility needs a recent successful probe
rep("""   if(now-Math.max(p.grantedAt||p.createdAt,p.lastHandshake||0)>stale)continue;
""","""   if(now-Math.max(p.grantedAt||p.createdAt,p.lastHandshake||0)>stale)continue;
   // and its DNS role answered the LAST probe through the tunnel, recently (a live tunnel to a dead or absent route-dns
   // is not a DNS target)
   if(p.dnsOk!==true||!(now-(p.dnsCheckedAt||0)<=stale))continue;
""")
rep(""" // WireGuard's own last handshake per peer (kernel stats), for the DNS liveness rule; a failed read changes nothing
 async observeHandshakes(){""",""" // Probe every pinned host's DNS role through its tunnel (each sweep, and right after its grant); the result gates dnsTarget.
 async probeDnsPeers(peers=null){
  const dns=this.config.hostServices?.dns;if(!dns?.hosts?.length)return;
  const pins=new Set(dns.hosts.map(h=>String(h).toLowerCase())),now=this.now();
  const list=(peers||[...this.peers.values()]).filter(p=>p.role==='service'&&p.expiresAt>now&&pins.has(p.runner));
  await Promise.all(list.map(async p=>{let ok=false;if(this.dnsProbe){try{ok=await this.dnsProbe(p.address)===true;}catch{}}
   if(p.dnsOk!==ok)this.log(`dns role of host ${p.runner.slice(0,10)} at ${p.address}: ${ok?'answering':'NOT answering'}`);
   p.dnsOk=ok;p.dnsCheckedAt=this.now();}));
 }
 // WireGuard's own last handshake per peer (kernel stats), for the DNS liveness rule; a failed read changes nothing
 async observeHandshakes(){""")
rep("""  await this.prune();
  await this.observeHandshakes();
  await this.sync();
 }""","""  await this.prune();
  await this.observeHandshakes();
  await this.probeDnsPeers();
  await this.sync();
 }""")
# after a pinned host's grant: probe it now, then re-sync (the grant itself returns at once)
rep("""  this.peers.set(peer.key,peer);await this.kernel.setPeer(peer);await this.sync();await this.persist();
  const grant={version:1,providerId:this.config.providerId,role:'service',""","""  this.peers.set(peer.key,peer);await this.kernel.setPeer(peer);await this.sync();await this.persist();
  if(this.config.hostServices?.dns?.hosts?.includes(peer.runner)&&peer.dnsOk!==true)void this.probeDnsPeers([peer]).then(()=>this.sync()).catch(e=>this.log('dns probe: '+e.message));
  const grant={version:1,providerId:this.config.providerId,role:'service',""")
open(p,'w').write(s)
