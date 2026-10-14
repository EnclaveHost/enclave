#!/usr/bin/env node
// The host's privacy agent: every app this host serves reaches the internet, and is reached, only through the Enclave
// network (docs/design/enclave-network.md) - two WireGuard circuits through qualified providers, the owner's bring-your-own
// WireGuard peer, or (on a host that opted in) direct hosting on its own qualified public address, as the owner's signed
// v5 network policy says. TUNA (NKN) is retired: a configuration without enclaveNetwork is refused, and the retired TUNA
// settings an older configuration may still carry are ignored.
import {startingShieldTransport} from './shield-starting-transport.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {privateKeyToAccount} from 'viem/accounts';
import {LeaseReader,AdmissionGate} from './lease-reader.mjs';
import {EnclaveNetworkManager} from './wg-manager.mjs';
import {createNetworkHost} from './enclave-network-host.mjs';
import {WgControlTransport} from './wg-control.mjs';
import {createPaidNetwork} from './paid-network.mjs';
import {ShieldHostProof} from './shield-host-proof.mjs';
import {RoutePublisher} from './route-publisher.mjs';
import {EgressMap} from './egress-map.mjs';
// how long a lease still running on chain is believed from its last agreeing read when a chain read fails outright
const LEASE_GRACE_MS=10*60_000;
import {DurableState} from './durable-state.mjs';
import {localAppForwarder} from './local-app-transport.mjs';
import {pvmAppPort,openPvmApp,pvmForwarder} from './pvm-app-transport.mjs';
import {probeGuest} from './guest-probe.mjs';
import {createProbeScheduler} from './probe-scheduler.mjs';
import {GuestdIngress} from './guestd-ingress.mjs';
import {ShieldIngress} from './shield-ingress.mjs';
import {guardedFetch} from './guarded-fetch.mjs';
import {delegatedIPNS} from './discovery-http.mjs';
import {validateAppNames} from './app-ingress.mjs';

// Settings of the retired TUNA transport (and of the TUNA-era direct hosting it carried) that an older configuration may
// still hold. They are ignored, never acted on: no NKN wallet, provider inventory, control guard or currency conversion runs.
export const RETIRED_SETTINGS=['nknRpc','inventory','control','runtime','defaults','tunaUSDC','currencyManagement','connectivity','direct'];
export const NETWORK_REQUIRED='enclaveNetwork configuration required: TUNA is retired, and apps are served only on the Enclave network (docs/design/enclave-network.md)';

// Timely admission is independent of slow allocation and publication work. Even
// a hung RPC, allocator or distributor cannot extend an old authorization.
export class PrivacyAgent {
  constructor({apps,runner,account,leaseReader,probe,distribute,directory,dns,network,qualification,paid=null,now=Date.now,log=()=>{}}){
    if(!network)throw new Error(NETWORK_REQUIRED);
    Object.assign(this,{apps,leaseReader,probe,distribute,directory,now,log,network});this.refreshing=false;this.closed=false;this.publishing=false;
    this.admission=new AdmissionGate({runner,expected:id=>this.apps.find(a=>a.deploymentId===id)?.expected,now});
    this.manager=new EnclaveNetworkManager({runtime:network.runtime,admission:this.admission,providers:network.providers,byoConfig:network.byoConfig,probeEgress:network.probeEgress,direct:network.direct,paid,now,log,
      probe:(app,circuit)=>probe(app.deploymentId,app.expected,circuit),publish:(id,routes)=>this.publisher.publish(id,routes)});
    this.publisher=new RoutePublisher({directory:path.join(directory,'routes'),account,lease:id=>leaseReader.get(id),
      policy:id=>this.manager.apps.get(id)?.policy,qualification,now,distribute:async(id,value)=>{
        if(distribute)await distribute(id,value).catch(e=>log('optional route mirror: '+e.message));
      }});
    this.egress=new EgressMap({directory,manager:this.manager,dns,now,log});this.status=new DurableState(directory);
  }
  async refreshAuthorization(){
    if(this.refreshing||this.closed)return;this.refreshing=true;this.authorizationRefresh={phase:"chain",startedAt:this.now()};void this.snapshot().catch(e=>this.log(e.message));
    try{
      // A chain read that fails outright (the control circuits or this host's uplink down for a minute) must not lapse
      // every app: leases still running on chain are held up to LEASE_GRACE_MS after their last agreeing read, and the
      // round goes on to the policies and guest proofs (2026-10-13 15:21Z: control circuits down ~1 min -> three apps'
      // egress OFF, their leases fine).
      let leases;
      try{leases=await this.leaseReader.refresh(this.apps.map(a=>a.deploymentId));}
      catch(e){
        const held=this.leaseReader.hold?this.leaseReader.hold(LEASE_GRACE_MS):[];
        this.log(`chain authorization read failed: ${e.message}; ${held.length} running lease(s) held from their last agreeing read`);
        leases=held.map(id=>this.leaseReader.get(id)).filter(Boolean);
      }
      for(const lease of leases)this.admission.observeLease(lease);
      this.authorizationRefresh.phase="policy";void this.snapshot().catch(e=>this.log(e.message));
      const policies=await Promise.allSettled(this.apps.map(async app=>{const lease=this.leaseReader.get(app.deploymentId);
        if(!this.network.onNetwork(app.deploymentId))throw new Error('not on the Enclave network (enclaveNetwork.apps), and TUNA is retired');
        return {...app,isPublic:!!lease?.isPublic,policy:await this.network.policyFor(app,lease)};}));
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
      setInterval(()=>{if(this.publishing||this.closed)return;this.publishing=true;void Promise.allSettled([...this.manager.apps.values()].map(app=>this.manager.publishApp(app))).finally(()=>{this.publishing=false;});},10000),
      setInterval(()=>void this.manager.reconcile().catch(e=>this.log('circuits: '+e.message)),5000)];
    void this.manager.reconcile().catch(e=>this.log('circuits: '+e.message));return this;
  }
  async close(){if(this.closed)return;this.closed=true;for(const timer of this.timers||[])clearInterval(timer);await this.manager.close();await this.snapshot();}
}

export async function runPrivacy(configFile){
  const cfg=JSON.parse(await fs.readFile(configFile,'utf8'));
  if(cfg.version!==2||!Array.isArray(cfg.apps)||!cfg.apps.length||cfg.apps.length>256||!path.isAbsolute(cfg.directory))throw new Error('version 2 app configuration required');
  if(!cfg.enclaveNetwork||typeof cfg.enclaveNetwork!=='object')throw new Error(NETWORK_REQUIRED);
  // each line carries its UTC time: a cut stream has to be matched against circuit events, and the log had none
  const log=message=>console.error(new Date().toISOString().slice(11,19)+' [privacy] '+message);
  const retired=RETIRED_SETTINGS.filter(k=>k in cfg);
  if(retired.length)log(`ignoring retired TUNA-era settings: ${retired.join(', ')}`);
  const readJSON=async file=>JSON.parse(await fs.readFile(file,'utf8'));
  let key=cfg.operatorKeyFile?(await fs.readFile(cfg.operatorKeyFile,'utf8')).trim():(await readJSON(cfg.operatorConfigFile)).registryKey;
  const account=privateKeyToAccount(key);key=null;
  // An app's route is decided by its owner's v5 network policy (read from the relay), never by this file: per-app TUNA
  // settings (walletsFile, ownerPolicyFile, internetMode) are ignored.
  const loadApp=async item=>{
    const expected=await readJSON(item.expectedFile);
    if(!expected.appRef||typeof expected.configCid!=='string'||!/^0x[0-9a-f]{64}$/.test(item.deploymentId)||!Array.isArray(item.names)||!item.names.length)throw new Error('explicit app expectations and names required');
    validateAppNames(item.deploymentId,item.names);
    if(item.publishToMirror!==undefined&&typeof item.publishToMirror!=='boolean')throw new Error('publishToMirror must be true or false');
    if(item.startupEgress===true&&(expected.requiresConfigSocketServer!==true||expected.requiresSecretsV1!==true))throw new Error('startup egress needs a configured secret command');
    return {...item,expected};
  };
  const apps=[];
  for(const item of cfg.apps)apps.push(await loadApp(item));
  let verifySnp;
  if(cfg.verifierModule){if(!path.isAbsolute(cfg.verifierModule))throw new Error('local verifier module required');verifySnp=(await import(pathToFileURL(cfg.verifierModule).href)).judge;}
  const windows=process.platform==='win32';let linux,shield,hostProof,pvm;
  if(cfg.pvm){
    // a pVM host (a phone's protected VM): the relay's own pins for the tier, and the loopback port of the VM's TLS app port
    const hex=(xs,re)=>Array.isArray(xs)&&xs.length&&xs.every(x=>re.test(x));
    if(!hex(cfg.pvm.codeHashes,/^[0-9a-f]{64}$/)||!hex(cfg.pvm.authorityHashes,/^[0-9a-f]{128}$/)||!hex(cfg.pvm.runtimeIds,/^[0-9a-f]{64}$/))
      throw new Error('pvm needs codeHashes, authorityHashes and runtimeIds (the tier\'s pins)');
    pvm={appPort:pvmAppPort(cfg.pvm),codeHashes:cfg.pvm.codeHashes,authorityHashes:cfg.pvm.authorityHashes,runtimeIds:cfg.pvm.runtimeIds};
    if(cfg.guestd||cfg.upstream||cfg.shield||cfg.linux)throw new Error('a pVM host takes no guest manager, upstream, Shield or Linux configuration');
  }else if(windows){
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
  let agent;
  if(windows&&cfg.guestd)throw new Error('Linux guest manager configuration on Windows');
  if(!windows&&cfg.shield?.ingress)throw new Error('Windows partition ingress configuration on Linux');
  const guestd=cfg.guestd?new GuestdIngress({...cfg.guestd,expected:id=>apps.find(a=>a.deploymentId===id)?.expected}):
    cfg.shield?.ingress?new ShieldIngress({...cfg.shield.ingress,expected:id=>apps.find(a=>a.deploymentId===id)?.expected,key:id=>agent?.admission.proofs.get(id)?.spkiSha256}):null;
  const scheduleProbe=createProbeScheduler();
  let wgControl=null,paid=null;
  const close=()=>{hostProof?.close();void Promise.all([agent?.close(),wgControl?.close()]).then(()=>paid?.close()).catch(e=>log(e.message));};
  process.once('SIGTERM',close);process.once('SIGINT',close);
  // SIGHUP re-reads the app list: each app's expectation, names and mirror
  // flag, and any new app. Everything is validated before anything changes; no
  // existing circuit is rebuilt (new names apply to circuits built later).
  // An app dropped from the file is left alone (its lease decides its fate).
  const reloadApps=async()=>{try{
    const fresh=JSON.parse(await fs.readFile(configFile,'utf8'));
    if(!Array.isArray(fresh.apps)||fresh.apps.length>256)throw new Error('version 2 app configuration required');
    const next=[];for(const item of fresh.apps)next.push(await loadApp(item));
    let added=0,updated=0;
    for(const n of next){
      const cur=apps.find(a=>a.deploymentId===n.deploymentId);
      if(!cur){apps.push(n);added++;continue;}
      if(JSON.stringify(cur.expected)!==JSON.stringify(n.expected)||JSON.stringify(cur.names)!==JSON.stringify(n.names)||cur.publishToMirror!==n.publishToMirror)updated++;
      for(const k of ['expected','names','publishToMirror','expectedFile','startupEgress'])cur[k]=n[k];
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
  // The Enclave network, before the lease reader: with enclaveNetwork.control the host's own chain reads and relay calls
  // leave through two guarded Enclave-network circuits (docs/design/enclave-network.md).
  let leaseReaderLate;
  const directFetch=globalThis.fetch;
  // through the control circuits when they are up; otherwise (or if they fail) directly, with a fresh deadline (the
  // caller's signal may already have expired on the failed attempt)
  const networkFetch=async(url,init={})=>{if(wgControl){try{await wgControl.proxies();return await guardedFetch(wgControl.proxies,{timeoutMs:15000,maxBytes:4194304})(url,init);}catch(e){if(cfg.enclaveNetwork?.controlRequired)throw e;}}
    return directFetch(url,{...init,signal:AbortSignal.timeout(15000)});};
  const network=await createNetworkHost({config:cfg.enclaveNetwork,account,runner:cfg.runner,rpc:cfg.chain?.rpc,addressBook:cfg.chain?.addressBook,
    leaseReader:{registryEntries:(...a)=>leaseReaderLate?leaseReaderLate.registryEntries(...a):Promise.reject(new Error('lease reader not ready yet')),
      bookAddress:(...a)=>leaseReaderLate?leaseReaderLate.bookAddress(...a):Promise.reject(new Error('lease reader not ready yet'))},directory:cfg.directory,log,fetch:networkFetch,
    authorize:id=>!agent?.closed&&!!agent?.admission.allows(id),forward:pvm?pvmForwarder(pvm.appPort):guestd?guestd.forward:localAppForwarder(cfg.upstream)});
  if(cfg.enclaveNetwork.control===true){wgControl=new WgControlTransport({runtime:network.runtime,providers:network.providers,log});await wgControl.start();}
  // paid providers (enclaveNetwork.paid): the lease must carry the on-chain connectivity authorization
  const leaseReader=new LeaseReader({...cfg.chain,...(cfg.enclaveNetwork.paid?{includeConnectivity:'auto',includeHostPayout:true}:{}),...(wgControl?{proxy:wgControl.proxies}:{})});leaseReaderLate=leaseReader;
  paid=cfg.enclaveNetwork.paid?await createPaidNetwork({config:cfg.enclaveNetwork.paid,directory:path.join(cfg.directory,'paid'),leaseReader,providers:network.providers,fetchFn:networkFetch,log}):null;
  agent=new PrivacyAgent({apps,runner:cfg.runner,account,leaseReader,directory:cfg.directory,dns:cfg.dns,network,paid,log,
    // the route publisher attaches the host's direct-hosting qualification to a direct route (v5)
    qualification:network.direct?.envelope,
    distribute:async(id,value)=>{
      if(!value)return;
      const circuits=agent.manager.apps.get(id)?.circuits.filter(c=>c.healthy&&!c.closed&&c.egress)||[];
      // the paths a publication may leave by: the app's own circuits, else (an app with website-only circuits) the
      // host's Enclave-network control circuits; never the host's own address
      const paths=circuits.length?circuits.map(c=>c.transport==='direct'?fetch:guardedFetch(c.egress,{timeoutMs:5000})):wgControl?[guardedFetch(wgControl.proxies,{timeoutMs:8000})]:[];
      if(!paths.length)return;
      const tasks=[];
      // Publishing to Nan's DNS mirror moves an app off the shared route for good
      // (the mirror remembers it), so it is opted into per app, never all at once.
      if(cfg.mirror&&apps.find(a=>a.deploymentId===id)?.publishToMirror===true)tasks.push((async()=>{
        let error;for(const publishFetch of paths){try{
          const post=path=>publishFetch(new URL(path,cfg.mirror),{method:'POST',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json'},
            body:JSON.stringify({publication:{version:2,endpoint:cfg.endpoint,policy:value.policy,bundle:value.bundle,
              status:agent.manager.status().find(x=>x.deploymentId===id)}})});
          const response=await post('/v1/network/routes');
          if(!response.ok)throw new Error('DNS mirror HTTP '+response.status);return;
        }catch(e){error=e;}}throw error;
      })());
      if(circuits.length)for(const origin of cfg.ipnsRouters||[])tasks.push(delegatedIPNS(origin,circuits[0].egress).publish(value.name,value.ipns));
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
      ...(!circuit&&pvm?{pvm}:!circuit&&windows?{shield,hostSession:await hostProof.get()}:!circuit?{linux:{...linux,measurement:expected.measurement,release:expected.release},verifySnp}:{}),
      ...(circuit?{address:circuit.address,direct:circuit.transport==='direct',proxy:circuit.transport==='direct'?undefined:circuit.isolation.guardAddress,domainIndependent:circuit.transport!=='direct'&&apps.find(a=>a.deploymentId===id)?.startupEgress===true}:apps.find(a=>a.deploymentId===id)?.startupEgress===true?{openApp:starting,startupEgress:true}:guestd?{openApp:id=>guestd.open(id)}:pvm?{openApp:()=>openPvmApp(pvm.appPort)}:{localUpstream:cfg.upstream})});
    })});
  try{await agent.start();}catch(e){hostProof?.close();await agent.close();await wgControl?.close();throw e;}
  return agent;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const i=process.argv.indexOf('--config');runPrivacy(process.argv[i+1]).catch(e=>{console.error(e.message);process.exitCode=1;});
}
