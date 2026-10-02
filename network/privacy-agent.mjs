#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {privateKeyToAccount} from 'viem/accounts';
import {LeaseReader,AdmissionGate} from './lease-reader.mjs';
import {CircuitManager} from './circuit-manager.mjs';
import {LinuxCircuitRuntime} from './linux-circuit-runtime.mjs';
import {ProviderInventory} from './provider-inventory.mjs';
import {RoutePublisher,appPolicy} from './route-publisher.mjs';
import {EgressMap} from './egress-map.mjs';
import {DurableState} from './durable-state.mjs';
import {localAppForwarder} from './local-app-transport.mjs';
import {probeGuest} from './guest-probe.mjs';
import {GuestdIngress} from './guestd-ingress.mjs';
import {guardedFetch} from './guarded-fetch.mjs';
import {delegatedIPNS} from './discovery-http.mjs';

// Timely admission is independent of slow allocation and publication work. Even
// a hung RPC, allocator or distributor cannot extend an old authorization.
export class PrivacyAgent {
  constructor({apps,runner,account,leaseReader,inventory,wallets,runtime,probe,distribute,directory,dns,defaults,now=Date.now,log=()=>{}}){
    Object.assign(this,{apps,leaseReader,inventory,probe,distribute,directory,now,log,defaults});this.refreshing=false;this.closed=false;this.publishing=false;
    this.admission=new AdmissionGate({runner,expected:id=>this.apps.find(a=>a.deploymentId===id)?.expected,now});
    this.manager=new CircuitManager({runtime,admission:this.admission,inventory:()=>inventory.get(),wallets,now,log,
      probe:(app,circuit)=>probe(app.deploymentId,app.expected,circuit),publish:(id,routes)=>this.publisher.publish(id,routes)});
    this.publisher=new RoutePublisher({directory:path.join(directory,'routes'),account,lease:id=>leaseReader.get(id),
      policy:id=>this.manager.apps.get(id)?.policy,now,distribute:async(id,value)=>{
        const copies=this.manager.apps.get(id)?.circuits.filter(c=>c.healthy&&!c.closed)||[];
        const record=value?{deploymentId:id,expiresAt:value.bundle.record.expiresAt,name:value.name,cid:value.cid,
          block:value.bytes.toString('base64'),ipns:Buffer.from(value.ipns).toString('base64')}:null;
        for(const circuit of copies){try{circuit.publishDiscovery(record);}catch(e){log('discovery copy: '+e.message);}}
        if(distribute)await distribute(id,value).catch(e=>log('optional route mirror: '+e.message));
      }});
    this.egress=new EgressMap({directory,manager:this.manager,dns,now});this.status=new DurableState(directory);
  }
  async refreshAuthorization(){
    if(this.refreshing||this.closed)return;this.refreshing=true;
    try{
      const leases=await this.leaseReader.refresh(this.apps.map(a=>a.deploymentId));
      for(const lease of leases)this.admission.observeLease(lease);
      const policies=await Promise.allSettled(this.apps.map(async app=>({...app,policy:await appPolicy(app,this.leaseReader.get(app.deploymentId),this.defaults)})));
      const configured=[];policies.forEach((r,i)=>{if(r.status==='fulfilled')configured.push(r.value);else{this.admission.revoke(this.apps[i].deploymentId);this.log(`app policy ${this.apps[i].deploymentId.slice(0,10)}: ${r.reason.message}`);}});
      await this.manager.configure(configured);
      const results=await Promise.allSettled(configured.map(app=>this.admission.attest(app.deploymentId,(id,expected)=>this.probe(id,expected,null))));
      results.forEach((r,i)=>{if(r.status==='rejected'){this.admission.revoke(configured[i].deploymentId);this.log(`local guest proof ${configured[i].deploymentId.slice(0,10)}: ${r.reason.message}`);}});
    }catch(e){this.log('chain/app authorization: '+e.message);}finally{this.refreshing=false;this.manager.enforceAdmission();}
  }
  async snapshot(){await this.egress.write();await this.status.set('status',{version:2,updatedAt:this.now(),apps:this.manager.status()});}
  async start(){
    await this.refreshAuthorization();await this.snapshot();
    this.timers=[setInterval(()=>{this.manager.enforceAdmission();void this.snapshot().catch(e=>this.log(e.message));},1000),
      setInterval(()=>void this.refreshAuthorization(),15000),
      setInterval(()=>void this.inventory.refresh().catch(e=>this.log('inventory: '+e.message)),20000),
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
  const leaseReader=new LeaseReader(cfg.chain),apps=[];
  for(const item of cfg.apps){
    const expected=await readJSON(item.expectedFile);
    if(!expected.appRef||typeof expected.configCid!=='string'||!/^0x[0-9a-f]{64}$/.test(item.deploymentId)||!Array.isArray(item.names)||!item.names.length)throw new Error('explicit app expectations and names required');
    apps.push({...item,expected,...(item.ownerPolicyFile?{ownerPolicy:await readJSON(item.ownerPolicyFile)}:{})});
  }
  let verifySnp;
  if(cfg.verifierModule){if(!path.isAbsolute(cfg.verifierModule))throw new Error('local verifier module required');verifySnp=(await import(pathToFileURL(cfg.verifierModule).href)).judge;}
  const linux={...cfg.linux,runtime:await readJSON(cfg.linux.runtimeFile),minTcb:await readJSON(cfg.linux.minTcbFile),vcek:await fs.readFile(cfg.linux.vcekFile),kds:false};
  if(cfg.linux.certChainFile){
    const seedModule=cfg.linux.snpModule?await import(pathToFileURL(cfg.linux.snpModule).href):await import('../relay/snp-verify.mjs');
    seedModule.seedCertChain(cfg.linux.product,await fs.readFile(cfg.linux.certChainFile,'utf8'));
  }
  const log=message=>console.error('[privacy] '+message);let agent;
  const guestd=cfg.guestd?new GuestdIngress({...cfg.guestd,expected:id=>apps.find(a=>a.deploymentId===id)?.expected}):null;
  const runtime=new LinuxCircuitRuntime({...cfg.runtime,directory:path.join(cfg.directory,'circuits'),rpc:cfg.nknRpc,
    authorize:id=>!!agent?.admission.allows(id),forward:guestd?guestd.forward:localAppForwarder(cfg.upstream),log});
  const inventory=new ProviderInventory({...cfg.inventory,rpc:cfg.nknRpc});
  agent=new PrivacyAgent({apps,runner:cfg.runner,account,leaseReader,inventory,runtime,directory:cfg.directory,dns:cfg.dns,defaults:cfg.defaults,log,
    wallets:async id=>readJSON(apps.find(a=>a.deploymentId===id).walletsFile),
    distribute:async(id,value)=>{
      if(!value)return;
      const circuits=agent.manager.apps.get(id)?.circuits.filter(c=>c.healthy&&!c.closed)||[];
      if(!circuits.length)return;
      const tasks=[];
      if(cfg.mirror)tasks.push((async()=>{
        let error;for(const circuit of circuits){try{
          const response=await guardedFetch(circuit.egress,{timeoutMs:5000})(new URL('/v1/network/tuna',cfg.mirror),{method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({publication:{version:2,endpoint:cfg.endpoint,policy:value.policy,bundle:value.bundle,ownerPolicy:apps.find(a=>a.deploymentId===id).ownerPolicy}})});
          if(!response.ok)throw new Error('DNS mirror HTTP '+response.status);return;
        }catch(e){error=e;}}throw error;
      })());
      for(const origin of cfg.ipnsRouters||[])tasks.push(delegatedIPNS(origin,circuits[0].egress).publish(value.name,value.ipns));
      const results=await Promise.allSettled(tasks);for(const r of results)if(r.status==='rejected')log('optional discovery transport: '+r.reason.message);
    },
    probe:async(id,expected,circuit)=>probeGuest({deploymentId:id,hostname:apps.find(a=>a.deploymentId===id).names[0],expected,
      linux:{...linux,measurement:expected.measurement,release:expected.release},verifySnp,
      ...(circuit?{address:circuit.address,proxy:circuit.isolation.guardAddress}:guestd?{openApp:id=>guestd.open(id)}:{localUpstream:cfg.upstream})})});
  await agent.start();
  const close=()=>{void agent.close().catch(e=>log(e.message));};process.once('SIGTERM',close);process.once('SIGINT',close);return agent;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const i=process.argv.indexOf('--config');runPrivacy(process.argv[i+1]).catch(e=>{console.error(e.message);process.exitCode=1;});
}
