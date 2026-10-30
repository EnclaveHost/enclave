// Execute the actual main module with local fixture files and injected host/worker
// boundaries. No PowerShell, network listener, production service or VM is used.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {sha256Hex} from './derive.mjs';
import {runtimeId} from '../../../isolation/contract/runtime.mjs';
import {DESKTOP_DERIVATION} from './desktop-derive.mjs';
async function boot(t,over={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-entry-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const exe=path.join(dir,'fixture.exe');fs.writeFileSync(exe,'non-executable fixture');
 const pin=sha256Hex(fs.readFileSync(exe));
 const runtime={name:'wasmtime',version:'test',execution:'jit',hostIsa:'x86_64',targetIsa:'x86_64',cpuFeatures:'baseline',wx:'enforced',cache:'none'};
 const profileText=fs.readFileSync(new URL('./testdata/desktop-platform/profile.json',import.meta.url),'utf8'),p=JSON.parse(profileText);
 const platform={igvmSha256:'f'.repeat(64),runtimeId:runtimeId(runtime).toString('hex'),profileText,profileSha256:sha256Hex(Buffer.from(profileText)),
  media:[['root',p.root.imageBytes,p.root.imageSha256],['hashes',p.root.hashBytes,p.root.hashSha256],['models',p.models.imageBytes,p.models.imageSha256]].map(([role,payloadBytes,payloadSha256],i)=>({role,path:`C:\\media\\${role}.iso`,bytes:payloadBytes+65536,sha256:String(i+1).repeat(64),payloadBytes,payloadSha256,payloadOffset:65536}))};
 const cfg={imagePath:'C:\\native\\igvm.bin',platform,runtime,bridge:{exe,sha256:pin},workerPort:19595,workerBudgetGb:12};
 const configPath=path.join(dir,'desktop.json');fs.writeFileSync(configPath,JSON.stringify(cfg));
 const gpuPath=path.join(dir,'gpu.json');fs.writeFileSync(gpuPath,JSON.stringify({runtime,imagePath:'gpu.bin',imageSha256:'b'.repeat(64),bridgeExe:exe,bridgeSha256:pin}));
 const env={ENCLAVE_GUEST_IGVM:'legacy.bin',ENCLAVE_GUEST_IGVM_SHA256:'a'.repeat(64),ENCLAVE_BOOT_FORM:'linux-direct',ENCLAVE_GUEST_CPU_ALLOWANCE:'1',
  ENCLAVE_WMISERVE_EXE:exe,ENCLAVE_WMISERVE_EXE_SHA256:pin,ENCLAVE_BUNDLE_DIR:dir,ENCLAVE_EGRESS_V1:'1',NODE_APP_RAM_GB:'32',NODE_VM_RAM_GB:'48',NODE_VCPUS:'16',
  ENCLAVE_CONFIG_BUNDLE_V5:'1',ENCLAVE_SECRETS_V1:'1',ENCLAVE_CONFIG_SOCKET_SERVER_V1:'1',ENCLAVE_PROTECTED_PORTS_V1:'1',
  ENCLAVE_DESKTOP_CONFIG:configPath,ENCLAVE_DESKTOP_CONFIG_SHA256:sha256Hex(fs.readFileSync(configPath)),ENCLAVE_PARTITION_LOG_DIR:'off',ENCLAVE_LIVENESS_MS:'0',ENCLAVE_ANSWER_CHECK_MS:'0',
  ...(over.gpu?{ENCLAVE_SHIELD_PROFILE:gpuPath}:{}),...(over.env??{})};
 const launches=[],events=[],logs=[];let manager;
 class FakeLauncher{
  constructor(options){this.options=options;this.desktopPlatform=options.desktopPlatform;this.boundary='host-trusted';launches.push(this);}
  async verifyImage(){events.push(['verify',this.options.imagePath]);if(over.imageFailure&&this.desktopPlatform)throw Error('native image differs');}
  async preflight(){return{ok:true,checks:[],hostLogicalProcessors:16};}
  async survey(){return{vms:[]};}
  async start(mapping,opts){events.push(['start',this.options.imagePath]);return{mapping,opts};}
 }
 const context=vm.createContext({process:{env,exit(code){throw Error('EXIT '+code);}},console:{log:s=>logs.push(s),error:s=>logs.push(s)},Buffer,
  setInterval:()=>({unref(){}}),clearInterval(){}});
 const url=new URL('./main.mjs',import.meta.url);
 const main=new vm.SourceTextModule(fs.readFileSync(url,'utf8'),{context,identifier:url.href,initializeImportMeta(meta){meta.url=url.href;}});
 await main.link(async spec=>{
  const resolved=spec.startsWith('.')?new URL(spec,url).href:spec;
  const actual=await import(resolved),exports={...actual};
  if(spec==='./wmi-launcher.mjs')exports.WmiHyperVLauncher=FakeLauncher;
  if(spec==='./psrun.mjs')exports.powershellRunner=()=>()=>{throw Error('host calls prohibited');};
  // Transfer configuration data from the isolated VM realm to the real Manager
  // realm; production main and Manager naturally share a realm. Callbacks stay intact.
  if(spec==='./server.mjs')exports.Manager=class extends actual.Manager{
   constructor(opts){super({...opts,images:structuredClone(opts.images)});}
  };
  if(spec==='./server.mjs')exports.createServer=m=>{manager=m;return{listen(port,host,cb){events.push(['listen',host]);cb();}};};
  if(spec==='./desktop-config.mjs')exports.probeDesktopWorker=async()=>{if(over.workerFailure)throw Error('worker unavailable');return{protocol:'1,4,0',vramBudgetGb:12};};
  if(spec==='./shield-profile.mjs')exports.probeWorker=async()=>({protocol:'1,4,0',vramBudgetGb:12});
  if(spec==='./desktop-worker-transport.mjs')exports.startDesktopWorkerTransport=async args=>{events.push(['worker',args]);return{fixture:true};};
  if(spec==='./egress.mjs'){
   exports.egressConfigFromEnv=env=>env.ENCLAVE_EGRESS_V1==='1'?{mode:'fixture',exe,sha256:pin,bridgeExe:exe,bridgeSha256:pin}:null;
   exports.startEgress=async args=>{events.push(['egress',args]);return{fixture:true};};
  }
  return new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context});
 });
 let error;try{await main.evaluate();}catch(e){error=e;}
 return{manager,launches,events,logs,error,cfg};
}
test('actual entry point wires separate native image, purchased quota, worker and egress',async t=>{
 const h=await boot(t);assert.equal(h.error,undefined,h.logs.join('\n'));assert.equal(h.launches.length,2);
 const m=h.manager,n=h.launches[1],health=m.health();assert.equal(m.cpuPoolVcpus,16);assert.equal(m.physicalRamPoolMiB,49152);
 assert.equal(n.options.imageRole,'desktop');assert.equal(n.options.guestCpuAllowance,true);assert.equal(n.options.imageSha256,h.cfg.platform.igvmSha256);
 assert.equal(n.options.medium,null);assert.equal(n.options.boot,'linux-direct');assert.equal(health.supports.desktop,true);
 assert.ok(health.catalog.derivations.includes(DESKTOP_DERIVATION));
 const mapping={record:{derivation:DESKTOP_DERIVATION}};
 await n.options.startTransport('test-vm',mapping);await n.options.startEgress('test-vm','test-deployment',mapping);
 const worker=h.events.find(x=>x[0]==='worker')[1];assert.equal(worker.mapping,mapping);assert.equal(worker.runtimeId,h.cfg.platform.runtimeId);assert.equal(worker.workerPort,19595);
 assert.equal(h.events.find(x=>x[0]==='egress')[1].deploymentId,'test-deployment');
});
test('actual entry point retains all three launch lanes when inference is configured',async t=>{
 const h=await boot(t,{gpu:true});assert.equal(h.error,undefined,h.logs.join('\n'));assert.equal(h.launches.length,3);
 for(const record of [{derivation:7},{derivation:4,inference:{}},{derivation:DESKTOP_DERIVATION,desktop:{}}])await h.manager.backend.start({record},{});
 assert.deepEqual(h.events.filter(x=>x[0]==='start').map(x=>x[1]),['legacy.bin','gpu.bin','C:\\native\\igvm.bin']);
 assert.equal(h.launches[0].options.guestCpuAllowance,true);assert.equal(h.launches[1].options.guestCpuAllowance,false);assert.equal(h.launches[2].options.guestCpuAllowance,true);
});
test('actual entry point without desktop configuration retains ordinary launch availability',async t=>{
 const h=await boot(t,{env:{ENCLAVE_DESKTOP_CONFIG:'',ENCLAVE_DESKTOP_CONFIG_SHA256:''}});
 assert.equal(h.error,undefined);assert.equal(h.launches.length,1);assert.equal(h.manager.health().canStart,true);assert.equal(h.manager.desktopReady,false);
});
test('worker failure disables native admission while ordinary manager remains available',async t=>{
 const h=await boot(t,{workerFailure:true});assert.equal(h.error,undefined);assert.equal(h.manager.health().canStart,true);assert.equal(h.manager.desktopReady,false);
 assert.ok(!h.manager.health().catalog.derivations.includes(DESKTOP_DERIVATION));
});
test('partial native configuration fails before the manager listens',async t=>{
 for(const env of [{ENCLAVE_DESKTOP_CONFIG_SHA256:''},{ENCLAVE_DESKTOP_CONFIG_SHA256:'0'.repeat(64)},{NODE_VM_RAM_GB:''},{ENCLAVE_PROTECTED_PORTS_V1:'0'},{ENCLAVE_EGRESS_V1:'0'},{NODE_VCPUS:'17'}]){
  const h=await boot(t,{env});
  if(env.NODE_VCPUS){assert.equal(h.error,undefined);assert.equal(h.manager.health().canStart,false);assert.equal(h.manager.desktopReady,false);}
  else{assert.match(h.error.message,/EXIT 2/);assert.equal(h.manager,undefined);}
 }
});
test('native image mismatch refuses entry-point startup',async t=>{
 const h=await boot(t,{imageFailure:true});assert.match(h.error.message,/EXIT 2/);assert.equal(h.manager,undefined);assert.ok(h.logs.some(s=>s.includes('native image differs')));
});
