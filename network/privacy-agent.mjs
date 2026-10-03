#!/usr/bin/env node
import {startingShieldTransport} from './shield-starting-transport.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import {privateKeyToAccount} from 'viem/accounts';
import {LeaseReader,AdmissionGate} from './lease-reader.mjs';
import {CircuitManager} from './circuit-manager.mjs';
import {LinuxCircuitRuntime} from './linux-circuit-runtime.mjs';
import {WindowsCircuitRuntime} from './windows-circuit-runtime.mjs';
import {ShieldHostProof} from './shield-host-proof.mjs';
import {ProviderInventory} from './provider-inventory.mjs';
import {RoutePublisher,appPolicy} from './route-publisher.mjs';
import {EgressMap} from './egress-map.mjs';
import {DurableState} from './durable-state.mjs';
import {localAppForwarder} from './local-app-transport.mjs';
import {probeGuest} from './guest-probe.mjs';
import {createProbeScheduler} from './probe-scheduler.mjs';
import {GuestdIngress} from './guestd-ingress.mjs';
import {ShieldIngress} from './shield-ingress.mjs';
import {guardedFetch} from './guarded-fetch.mjs';
import {delegatedIPNS} from './discovery-http.mjs';
import {ControlTransport} from './control-transport.mjs';
import {validateAppNames} from './app-ingress.mjs';
import {createUSDCBandwidthSettlement} from './usdc-bandwidth.mjs';
import {DirectRuntime} from './direct-runtime.mjs';
import {hostConnectivity,directTerms,validateHostConnectivity} from './connectivity-policy.mjs';
import {createProviderCanary} from './provider-canary.mjs';
import {directPolicyFromLease} from './connectivity-control.mjs';
import {TrafficMeter} from './traffic-meter.mjs';
import {recordHash} from './route-record.mjs';

// Timely admission is independent of slow allocation and publication work. Even
// a hung RPC, allocator or distributor cannot extend an old authorization.
export class PrivacyAgent {
  constructor({apps,runner,account,leaseReader,inventory,wallets,runtime,directRuntime,qualification,probe,distribute,directory,dns,defaults,now=Date.now,log=()=>{}}){
    Object.assign(this,{apps,leaseReader,inventory,probe,distribute,directory,now,log,defaults});this.refreshing=false;this.closed=false;this.publishing=false;
    this.admission=new AdmissionGate({runner,expected:id=>this.apps.find(a=>a.deploymentId===id)?.expected,now});
    this.manager=new CircuitManager({runtime,directRuntime,admission:this.admission,inventory:()=>inventory.get(),wallets,now,log,
      probe:(app,circuit)=>probe(app.deploymentId,app.expected,circuit),observe:(providers,result)=>inventory.observe?.(providers,result)||Promise.resolve(),publish:(id,routes)=>this.publisher.publish(id,routes)});
    this.publisher=new RoutePublisher({directory:path.join(directory,'routes'),account,lease:id=>leaseReader.get(id),
      policy:id=>this.manager.apps.get(id)?.policy,qualification,now,distribute:async(id,value)=>{
        const copies=this.manager.apps.get(id)?.circuits.filter(c=>c.healthy&&!c.closed)||[];
        const record=value?{deploymentId:id,expiresAt:value.bundle.record.expiresAt,name:value.name,cid:value.cid,
          block:value.bytes.toString('base64'),ipns:Buffer.from(value.ipns).toString('base64')}:null;
        for(const circuit of copies){try{circuit.publishDiscovery(record);}catch(e){log('discovery copy: '+e.message);}}
        if(distribute)await distribute(id,value).catch(e=>log('optional route mirror: '+e.message));
      }});
    this.egress=new EgressMap({directory,manager:this.manager,dns,now});this.status=new DurableState(directory);
  }
  async refreshAuthorization(){
    if(this.refreshing||this.closed)return;this.refreshing=true;this.authorizationRefresh={phase:"chain",startedAt:this.now()};void this.snapshot().catch(e=>this.log(e.message));
    try{
      const leases=await this.leaseReader.refresh(this.apps.map(a=>a.deploymentId));
      for(const lease of leases)this.admission.observeLease(lease);
      this.authorizationRefresh.phase="policy";void this.snapshot().catch(e=>this.log(e.message));
      const policies=await Promise.allSettled(this.apps.map(async app=>({...app,policy:await appPolicy(app,this.leaseReader.get(app.deploymentId),this.defaults)})));
      const configured=[];policies.forEach((r,i)=>{if(r.status==='fulfilled')configured.push(r.value);else{this.admission.revoke(this.apps[i].deploymentId);this.log(`app policy ${this.apps[i].deploymentId.slice(0,10)}: ${r.reason.message}`);}});
      await this.manager.configure(configured);
      this.authorizationRefresh.phase="guest-proof";void this.snapshot().catch(e=>this.log(e.message));
      // A proof lasts 60 s and is renewed once 40 s or less remain (three tries
      // before it lapses), so a guest is asked for a report 2-3 times a minute
      // (a Shield guest makes one at a time).
      const due=configured.filter(app=>!(this.admission.allows(app.deploymentId)&&this.admission.proofs.get(app.deploymentId).validUntil-this.now()>40000));
      const results=await Promise.allSettled(due.map(app=>this.admission.attest(app.deploymentId,(id,expected)=>this.probe(id,expected,null))));
      results.forEach((r,i)=>{if(r.status==='rejected'){const kept=this.admission.failed(due[i].deploymentId,r.reason);this.log(`local guest proof ${due[i].deploymentId.slice(0,10)}: ${r.reason.message}${kept?' (last proof kept until it expires)':''}`);}});
    }catch(e){this.authorizationRefresh.error=e.message;this.log('chain/app authorization: '+e.message);}finally{this.authorizationRefresh.completedAt=this.now();this.authorizationRefresh.phase='idle';this.refreshing=false;this.manager.enforceAdmission();}
  }
  async snapshot(){await this.egress.write();await this.status.set('status',{version:2,updatedAt:this.now(),authorizationRefresh:this.authorizationRefresh,apps:this.manager.status().map(app=>({...app,leaseUntil:this.admission.leases.get(app.deploymentId)?.validUntil||0,proofUntil:this.admission.proofs.get(app.deploymentId)?.validUntil||0}))});}
  async start(){
    await this.refreshAuthorization();if(this.closed)throw new Error('privacy agent stopped during startup');await this.snapshot();
    this.timers=[setInterval(()=>{this.manager.enforceAdmission();void this.snapshot().catch(e=>this.log(e.message));},1000),
      setInterval(()=>void this.refreshAuthorization(),15000),
      setInterval(()=>{if([...this.manager.apps.values()].some(a=>a.policy.mode!=='direct'))void this.inventory.refresh().catch(e=>this.log('inventory: '+e.message));},20000),
      setInterval(()=>{if(this.publishing||this.closed)return;this.publishing=true;void Promise.allSettled([...this.manager.apps.values()].map(app=>this.manager.publishApp(app))).finally(()=>{this.publishing=false;});},10000),
      setInterval(()=>void this.manager.reconcile().catch(e=>this.log('circuits: '+e.message)),5000)];
    void this.manager.reconcile().catch(e=>this.log('circuits: '+e.message));return this;
  }
  async close(){if(this.closed)return;this.closed=true;for(const timer of this.timers||[])clearInterval(timer);await this.manager.close();await this.snapshot();}
}

export async function runPrivacy(configFile){
  const cfg=JSON.parse(await fs.readFile(configFile,'utf8'));
  if(cfg.version!==2||!Array.isArray(cfg.apps)||!cfg.apps.length||cfg.apps.length>256||!path.isAbsolute(cfg.directory))throw new Error('version 2 app configuration required');
  const readJSON=async file=>JSON.parse(await fs.readFile(file,'utf8'));
  let key=cfg.operatorKeyFile?(await fs.readFile(cfg.operatorKeyFile,'utf8')).trim():(await readJSON(cfg.operatorConfigFile)).registryKey;
  const account=privateKeyToAccount(key);key=null;
  const loadApp=async item=>{
    const expected=await readJSON(item.expectedFile);
    if(!expected.appRef||typeof expected.configCid!=='string'||!/^0x[0-9a-f]{64}$/.test(item.deploymentId)||!Array.isArray(item.names)||!item.names.length)throw new Error('explicit app expectations and names required');
    validateAppNames(item.deploymentId,item.names);
    if(item.publishToMirror!==undefined&&typeof item.publishToMirror!=='boolean')throw new Error('publishToMirror must be true or false');
    if(item.startupEgress===true&&(expected.requiresConfigSocketServer!==true||expected.requiresSecretsV1!==true))throw new Error('startup egress needs a configured secret command');
    return {...item,expected,...(item.ownerPolicyFile?{ownerPolicy:await readJSON(item.ownerPolicyFile)}:{})};
  };
  const apps=[];
  for(const item of cfg.apps)apps.push(await loadApp(item));
  const directConfigured=cfg.connectivity?validateHostConnectivity(cfg.connectivity).direct:false;
  // Read owner choices before deciding whether native NKN wallets are needed.
  if(cfg.connectivity){const bootstrap=new LeaseReader({...cfg.chain,includeConnectivity:'auto',includeHostPayout:true});
    await bootstrap.refresh(apps.map(a=>a.deploymentId));
    for(const app of apps)app.chainDirect=!!directPolicyFromLease(bootstrap.get(app.deploymentId));}
  const needsTuna=apps.some(a=>!a.chainDirect&&a.ownerPolicy?.policy?.mode!=='direct');
  if(!needsTuna&&!directConfigured)throw new Error('direct hosting is not enabled');
  let verifySnp;
  if(cfg.verifierModule){if(!path.isAbsolute(cfg.verifierModule))throw new Error('local verifier module required');verifySnp=(await import(pathToFileURL(cfg.verifierModule).href)).judge;}
  const windows=process.platform==='win32';let linux,shield,hostProof;
  if(windows){
    if(!cfg.shield?.policyFile||!cfg.shield?.tpmBinary||!cfg.shield?.tpmSha256)throw new Error('independent Shield platform and TPM pins required');
    shield=await readJSON(cfg.shield.policyFile);hostProof=new ShieldHostProof({binary:cfg.shield.tpmBinary,sha256:cfg.shield.tpmSha256,policy:shield});
  }else{
    if(process.platform!=='linux'||!cfg.linux)throw new Error('supported measured host configuration required');
    linux={...cfg.linux,runtime:await readJSON(cfg.linux.runtimeFile),minTcb:await readJSON(cfg.linux.minTcbFile),vcek:await fs.readFile(cfg.linux.vcekFile),kds:false};
  }
  if(linux&&cfg.linux.certChainFile){
    const seedModule=cfg.linux.snpModule?await import(pathToFileURL(cfg.linux.snpModule).href):await import('../relay/snp-verify.mjs');
    seedModule.seedCertChain(cfg.linux.product,await fs.readFile(cfg.linux.certChainFile,'utf8'));
  }
  const log=message=>console.error('[privacy] '+message);let agent;
  if(windows&&cfg.guestd)throw new Error('Linux guest manager configuration on Windows');
  if(!windows&&cfg.shield?.ingress)throw new Error('Windows partition ingress configuration on Linux');
  const guestd=cfg.guestd?new GuestdIngress({...cfg.guestd,expected:id=>apps.find(a=>a.deploymentId===id)?.expected}):
    cfg.shield?.ingress?new ShieldIngress({...cfg.shield.ingress,expected:id=>apps.find(a=>a.deploymentId===id)?.expected,key:id=>agent?.admission.proofs.get(id)?.spkiSha256}):null;
  const Runtime=windows?WindowsCircuitRuntime:LinuxCircuitRuntime;
  const runtime=needsTuna?new Runtime({...cfg.runtime,directory:path.join(cfg.directory,'circuits'),rpc:cfg.nknRpc,
    authorize:id=>!agent?.closed&&!!agent?.admission.allows(id),forward:guestd?guestd.forward:localAppForwarder(cfg.upstream),log}):
    {async start(){throw new Error('TUNA runtime is not configured');},async close(){}};
  const inventory=needsTuna?new ProviderInventory({...cfg.inventory,rpc:cfg.nknRpc,log}):{get:async()=>[],refresh:async()=>[]};
  const control=cfg.control?new ControlTransport({network:cfg.runtime.network,...cfg.control,directory:path.join(cfg.directory,'control'),inventory,rpc:cfg.nknRpc,wallets:await readJSON(cfg.control.walletsFile),log}):null;
  const scheduleProbe=createProbeScheduler();
  let stopping=false;
  const close=()=>{stopping=true;hostProof?.close();void Promise.all([agent?.close(),control?.close(),runtime.close()]).catch(e=>log(e.message));};
  process.once('SIGTERM',close);process.once('SIGINT',close);
  // SIGHUP re-reads the app list: each app's expectation, names and mirror
  // flag, and any new app. Everything is validated before anything changes; no
  // existing circuit is rebuilt (new names apply to circuits built later).
  // An app dropped from the file is left alone (its lease decides its fate).
  const reloadApps=async()=>{try{
    const fresh=JSON.parse(await fs.readFile(configFile,'utf8'));
    if(!Array.isArray(fresh.apps)||fresh.apps.length>256)throw new Error('version 2 app configuration required');
    const next=[];for(const item of fresh.apps)next.push(await loadApp(item));
    if(!needsTuna&&next.some(a=>!directPolicyFromLease(leaseReader.get(a.deploymentId))&&a.ownerPolicy?.policy?.mode!=='direct'))throw new Error('adding TUNA apps requires configuring and restarting the TUNA runtime');
    let added=0,updated=0;
    for(const n of next){
      const cur=apps.find(a=>a.deploymentId===n.deploymentId);
      if(!cur){apps.push(n);added++;continue;}
      if(JSON.stringify(cur.expected)!==JSON.stringify(n.expected)||JSON.stringify(cur.names)!==JSON.stringify(n.names)||cur.publishToMirror!==n.publishToMirror)updated++;
      for(const k of ['expected','names','publishToMirror','ownerPolicy','publicFallback','expectedFile','walletsFile','startupEgress'])cur[k]=n[k];
    }
    log(`config reloaded: ${apps.length} apps (${added} added, ${updated} changed); mirror apps: `+(apps.filter(a=>a.publishToMirror).map(a=>a.deploymentId.slice(0,10)).join(',')||'none'));
  }catch(e){log('config reload refused: '+e.message);}};
  process.on('SIGHUP',()=>void reloadApps());
  // Windows has no SIGHUP: the config file's modification time is the signal
  // there (the reconciler rewrites or touches it), and works on Linux too.
  let configStamp=(await fs.stat(configFile)).mtimeMs;
  setInterval(()=>void fs.stat(configFile).then(st=>{if(st.mtimeMs!==configStamp){configStamp=st.mtimeMs;return reloadApps();}}).catch(e=>log('config watch: '+e.message)),30000).unref();
  const starting=windows&&cfg.shield?.manager?startingShieldTransport(cfg.shield.manager,id=>apps.find(a=>a.deploymentId===id)?.expected):null;
  if(apps.some(a=>a.startupEgress)&&!starting)throw new Error('startup egress needs the local Shield manager');
  if(control)await control.start();
  if(stopping)throw new Error('privacy agent stopped during bootstrap');
  if(control)inventory.asns.fetchFn=guardedFetch(control.proxies,{timeoutMs:6000,maxBytes:65536});
  if(needsTuna&&!control&&!cfg.chain.proxy)throw new Error('independent guarded control transport required');
  const leaseReader=new LeaseReader({...cfg.chain,includeHostPayout:directConfigured,includeConnectivity:cfg.connectivity?'auto':false,...(control?{proxy:control.proxies}:{})});
  let directRuntime,qualification,settlement;
  if(directConfigured){
    if(!cfg.direct?.qualificationFile||!Array.isArray(cfg.direct.probeSigners))throw new Error('provider qualification configuration required');
    qualification=()=>readJSON(cfg.direct.qualificationFile);
    // A settlement adapter is mandatory for a nonzero rate. Free self-hosting
    // works without a TUNA wallet, a funded balance, or a payment adapter.
    settlement=cfg.direct.settlement?await createUSDCBandwidthSettlement({config:cfg.direct.settlement,directory:path.join(cfg.directory,'billing'),leaseReader,log}):undefined;
    const authorizeDebit=settlement?request=>settlement.authorizeDebit(request):undefined;
    const canary=cfg.direct.probe?await createProviderCanary(cfg.direct.probe,{address:cfg.direct.address,ownAddresses:cfg.direct.ownAddresses}):undefined;
    directRuntime=new DirectRuntime({...cfg.direct,canary,authorize:id=>!agent?.closed&&!!agent?.admission.allows(id),
      forward:guestd?guestd.forward:localAppForwarder(cfg.upstream),log,
      terms:async(id,policy)=>{
        const host=await hostConnectivity({config:cfg.connectivity,qualification:await qualification(),hostId:cfg.runner,
          operator:account.address,address:cfg.direct.address,probeSigners:cfg.direct.probeSigners});
        const lease=leaseReader.get(id);return directTerms({policy,host,lease,payoutWallet:lease?.runnerPayoutWallet});
      },
      meter:async(id,policy,terms)=>new TrafficMeter({directory:path.join(cfg.directory,'traffic'),deploymentId:id,policyHash:recordHash(policy),terms,authorizeDebit,recoverCounters:settlement?request=>settlement.recoverCounters(request):undefined})});
  }
  // Qualification must be able to probe the public listeners before any app
  // has qualified; the canary never admits an app or signs its own report.
  if(directRuntime?.canary)await directRuntime.listen();
  if(settlement&&directRuntime){const close=directRuntime.close.bind(directRuntime);directRuntime.close=async()=>{await close();await settlement.close();};}
  agent=new PrivacyAgent({apps,runner:cfg.runner,account,leaseReader,inventory,runtime,directRuntime,qualification,directory:cfg.directory,dns:cfg.dns,defaults:cfg.defaults,log,
    wallets:async id=>readJSON(apps.find(a=>a.deploymentId===id).walletsFile),
    distribute:async(id,value)=>{
      if(!value)return;
      const circuits=agent.manager.apps.get(id)?.circuits.filter(c=>c.healthy&&!c.closed)||[];
      if(!circuits.length)return;
      const tasks=[];
      // Publishing to Nan's DNS mirror moves an app off the shared route for good
      // (the mirror remembers it), so it is opted into per app, never all at once.
      if(cfg.mirror&&apps.find(a=>a.deploymentId===id)?.publishToMirror===true)tasks.push((async()=>{
        let error;for(const circuit of circuits){try{
          const publishFetch=circuit.transport==='direct'?fetch:guardedFetch(circuit.egress,{timeoutMs:5000});
          const response=await publishFetch(new URL('/v1/network/tuna',cfg.mirror),{method:'POST',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json'},
            body:JSON.stringify({publication:{version:2,endpoint:cfg.endpoint,policy:value.policy,bundle:value.bundle,ownerPolicy:apps.find(a=>a.deploymentId===id).ownerPolicy}})});
          if(!response.ok)throw new Error('DNS mirror HTTP '+response.status);return;
        }catch(e){error=e;}}throw error;
      })());
      for(const origin of cfg.ipnsRouters||[])tasks.push(delegatedIPNS(origin,circuits[0].egress).publish(value.name,value.ipns));
      const results=await Promise.allSettled(tasks);for(const r of results)if(r.status==='rejected')log('optional discovery transport: '+r.reason.message);
    },
    // Only local attestations need serialization: pinned route probes make no
    // TPM reports and must not delay the 60-second authorization renewal.
    // A route probe pins the TLS key of the app's current local proof (no new
    // guest report); the local proof itself always asks for a fresh report.
    probe:async(id,expected,circuit)=>scheduleProbe(id,!!circuit,async()=>{
      if(circuit&&!agent?.admission.allows(id))throw new Error('no current local guest proof');
      return probeGuest({deploymentId:id,hostname:apps.find(a=>a.deploymentId===id).names[0],expected,
      ...(circuit&&agent?.admission.allows(id)?{pinnedSpkiSha256:agent.admission.proofs.get(id).spkiSha256}:{}),
      ...(!circuit&&windows?{shield,hostSession:await hostProof.get()}:!circuit?{linux:{...linux,measurement:expected.measurement,release:expected.release},verifySnp}:{}),
      ...(circuit?{address:circuit.address,direct:circuit.transport==='direct',proxy:circuit.transport==='direct'?undefined:circuit.isolation.guardAddress,domainIndependent:circuit.transport!=='direct'&&!circuit.directPort&&apps.find(a=>a.deploymentId===id)?.startupEgress===true}:apps.find(a=>a.deploymentId===id)?.startupEgress===true?{openApp:starting,startupEgress:true}:guestd?{openApp:id=>guestd.open(id)}:{localUpstream:cfg.upstream})}).then(async result=>{
        if(circuit?.directPort)await probeGuest({deploymentId:id,hostname:apps.find(a=>a.deploymentId===id).names[0],address:circuit.address,port:circuit.directPort,
          proxy:circuit.isolation.guardAddress,expected,domainIndependent:true,pinnedSpkiSha256:result.spkiSha256});
        return result;
      });})});
  // A public provider address holds one HTTPS allocation. Every address already
  // routed for another app (any host, from Nan's public map) is skipped when
  // choosing, so this host does not wait out allocation timeouts against it.
  // Used for that choice only, never for authorization.
  if(control){
    const occupiedFetch=guardedFetch(control.proxies,{timeoutMs:8000,maxBytes:1048576});
    const refreshOccupied=async()=>{try{
      const own=new Set(apps.map(a=>a.deploymentId.slice(2,10)));
      const res=await occupiedFetch(new URL('/v1/network/tuna',cfg.mirror||'https://api.enclave.host'));
      if(!res.ok)throw new Error('HTTP '+res.status);
      const map=await res.json(),taken=new Set();
      for(const [label,l] of Object.entries(map?.labels||{})){
        if(own.has(label)||!l||typeof l!=='object')continue;
        for(const a of [...(Array.isArray(l.addresses)?l.addresses:[]),l.a,l.aaaa])if(typeof a==='string'&&net.isIP(a))taken.add(a);
      }
      agent.manager.occupiedElsewhere=taken;
    }catch(e){log('occupied providers: '+e.message);}};
    await refreshOccupied();setInterval(()=>void refreshOccupied(),30000).unref();
  }
  try{await agent.start();}catch(e){hostProof?.close();await agent.close();await control?.close();throw e;}
  return agent;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const i=process.argv.indexOf('--config');runPrivacy(process.argv[i+1]).catch(e=>{console.error(e.message);process.exitCode=1;});
}
