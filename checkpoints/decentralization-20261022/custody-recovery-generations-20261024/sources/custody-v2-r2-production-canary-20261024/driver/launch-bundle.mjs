// Builds and verifies a launch package only. Never launches a process, reads registry keys, or sends a transaction.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {canonical,sha256hex} from './canonical.mjs';
import {createRecoveryStateGate} from './recovery-state.mjs';
import {captureHostCopy} from './capture-host-copy.mjs';
import {checkR2Manifest} from './attestation.mjs';
import {R2,ORIGINAL_VAULT_V2,METAL0_ENDPOINT,OLD_CUSTODIAN_ENDPOINT,OLD_COMMITTEE_4774} from './plan.mjs';
import {validateCaptureDirectory,validateCaptureEndpoint} from './genesis-capture.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const HOOKS={'resolve-register.mjs':'16deae35e7f1ccbb53969c762288e043c879e394c3018785c21f8ec0d475c29a',
 'resolve-as-original.mjs':'30cd9f2cd53ecc82509bc8ade157a934c16dcd0dead7e717480f85c9dc353fe7'};
const CAPTURE_DEPS=['genesis-capture.mjs','canary-process.mjs','private-log.mjs','recovery-state.mjs','canonical.mjs','plan.mjs','budget.mjs'];
const need=(v,m)=>{if(!v)throw Error('launch package refused: '+m);};
const plainPath=p=>typeof p==='string'&&path.isAbsolute(p)&&!/[\x00-\x1f,]/.test(p)&&path.normalize(p)===p;
function regular(p,max=Infinity) {
 need(plainPath(p)&&fs.realpathSync(p)===p,'absolute non-symlink file required');
 const st=fs.lstatSync(p);need(st.isFile()&&!st.isSymbolicLink()&&st.size<=max,'regular bounded file required');return st;
}
export function digestFile(p,max=Infinity) {
 regular(p,max);const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=createHash('sha256'),buf=Buffer.alloc(65536);
 try {let n;while((n=fs.readSync(fd,buf,0,buf.length,null)))hash.update(buf.subarray(0,n));return hash.digest('hex');}finally{fs.closeSync(fd);}
}
const realDir=p=>{need(plainPath(p)&&fs.realpathSync(p)===p&&fs.lstatSync(p).isDirectory(),'absolute non-symlink directory required');};
function checkedInputs(pins) {
 const c=pins.custodian,l=pins.launch;
 need(l&&pins.repo?.commit===R2.commit,'reviewed repository and launch pins required');
 validateCaptureEndpoint(c.endpoint);need(c.endpoint!==OLD_CUSTODIAN_ENDPOINT&&c.endpoint!==new URL(METAL0_ENDPOINT).origin,'dedicated canary origin required');
 const manifestFile=c.manifestFile;regular(manifestFile,1048576);const manifest=checkR2Manifest(fs.readFileSync(manifestFile));
 const dist=path.dirname(manifestFile);realDir(dist);realDir(pins.repo.path);
 const files={};const pin=(p,want,max)=>{const actual=digestFile(p,max);need(actual===want,'file digest differs');files[p]=actual;};
 pin(manifestFile,R2.manifestSha256,1048576);
 pin(path.join(dist,'vmlinuz'),manifest.kernel.sha256,67108864);
 pin(path.join(dist,'initramfs.cpio.gz'),manifest.initramfs.sha256,manifest.initramfs.bytes);
 need(fs.statSync(path.join(dist,'initramfs.cpio.gz')).size===manifest.initramfs.bytes,'initramfs length differs');
 const cmdline=path.join(dist,'cmdline');regular(cmdline,4096);
 need(fs.readFileSync(cmdline,'utf8').trim()===manifest.cmdline,'kernel command line differs');files[cmdline]=digestFile(cmdline);
 pin(l.ovmf,manifest.ovmfSha256,33554432);
 need(/^[0-9a-f]{64}$/.test(l.qemuSha256??''),'QEMU digest pin required');pin(l.qemu,l.qemuSha256,536870912);
 need((fs.statSync(l.qemu).mode&0o111)!==0,'QEMU is not executable');
 const host=path.join(pins.repo.path,'custody/v2/host.mjs');pin(host,R2.hostSha256,262144);
 const registry=regular(l.registryKeyFile,1048576);
 need(registry.uid===process.getuid()&&(registry.mode&0o777)===0o600,'registry-key file must be owned and private; key is not read');
 need(Number.isSafeInteger(l.hostPort)&&Number.isSafeInteger(l.mgmtPort)&&l.hostPort>=1024&&l.hostPort<=65535&&l.mgmtPort>=1024&&l.mgmtPort<=65535&&l.hostPort!==l.mgmtPort,'distinct unprivileged ports required');
 need(Array.isArray(pins.rpcs)&&pins.rpcs.length>=2&&new Set(pins.rpcs).size===pins.rpcs.length,'distinct RPCs required');
 for(const rpc of pins.rpcs){const u=new URL(rpc);need(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash,'credential-free HTTPS RPC required');}
 const hooks={};for(const [name,want] of Object.entries(HOOKS)){const p=path.join(HERE,'launch',name);pin(p,want,16384);hooks[name]=fs.readFileSync(p,'utf8');}
 for(const name of CAPTURE_DEPS){const p=path.join(HERE,name);files[p]=digestFile(p,262144);}
 const node=fs.realpathSync(process.execPath);files[node]=digestFile(node,536870912);
 return {files,dist,host,node,hooks};
}
function compile(pins,bundle,inputs,recovery=null) {
 const origin=recovery?.originBundle??bundle;
 need(pins.custodian.captureDir===path.join(origin,"capture"),"genesis capture directory must be this launch package's capture directory");
 const config={dist:inputs.dist,ovmf:pins.launch.ovmf,qemu:pins.launch.qemu,sevDevice:'/dev/sev',cpus:2,memMiB:3072,
  tunnelName:'custody-r2-canary',endpoint:pins.custodian.endpoint,registryEndpoint:METAL0_ENDPOINT,
  hostPort:pins.launch.hostPort,mgmtPort:pins.launch.mgmtPort,stateDir:path.join(origin,'state'),canarySubmitDir:path.join(origin,'capture'),canaryLogDir:path.join(bundle,'logs'),
  genesis:!recovery,...(recovery?{committeeId:recovery.committeeId,canaryRecovery:recovery.stopped.sealedState,canaryRecoveryFault:recovery.mode==='state-503'?'state-503':null}:{}),vault:ORIGINAL_VAULT_V2,rpcs:pins.rpcs,rpc:pins.rpcs[0],registryKeyFile:pins.launch.registryKeyFile};
 const copy=path.join(bundle,'host.mjs'),cfg=path.join(bundle,'config.json'),register=path.join(bundle,'resolve-register.mjs');
 const made=captureHostCopy(fs.readFileSync(inputs.host),{captureURL:pathToFileURL(path.join(HERE,'genesis-capture.mjs')).href});
 const artifacts={'host.mjs':made.source,'config.json':JSON.stringify(config,null,2)+'\n',...inputs.hooks};
 const launch={executable:inputs.node,args:['--import',pathToFileURL(register).href,copy,cfg],
  environment:{PATH:'/usr/bin:/bin',CANARY_HOST_COPY_URL:pathToFileURL(copy).href,CANARY_HOST_ORIGINAL_URL:pathToFileURL(inputs.host).href},
  requiredCgroup:{memoryMaxMiB:5120,memorySwapMaxMiB:0},guestMiB:3072,reservedRecipientMiB:2048,minimumMemAvailableMiB:16384,
  note:'No inherited environment. No automatic launch. Require fresh host authority, protected-guest inventory, port availability, resource guard, ingress verification and live SNP attestation before G.launch can pass.'};
 const description={v:1,kind:recovery?'r2-capture-only-recovery':'r2-capture-only-launch',...(recovery?{recovery}:{}),bundle,endpoint:config.endpoint,source:R2.commit,manifestSha256:R2.manifestSha256,
  artifacts:Object.fromEntries(Object.entries(artifacts).map(([n,b])=>[n,sha256hex(b)])),inputs:inputs.files,launch};
 return {artifacts,description,digest:sha256hex(canonical(description))};
}
function writeExclusive(file,bytes) {const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function syncDir(d){const fd=fs.openSync(d,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function stageLaunchBundle({pins,parent,name}) {
 validateCaptureDirectory(parent);need(/^r2-launch-\d{8}T\d{6}Z$/.test(name??''),'unique timestamped package name required');
 const bundle=path.join(parent,name);need(!fs.existsSync(bundle),'package already exists; inspect rather than overwrite');
 const inputs=checkedInputs(pins),made=compile(pins,bundle,inputs);
 fs.mkdirSync(bundle,{mode:0o700});validateCaptureDirectory(bundle);
 // Partial failure leaves the directory for inspection. No retry overwrites state or capture records.
 for(const d of ['state','capture','logs']){fs.mkdirSync(path.join(bundle,d),{mode:0o700});validateCaptureDirectory(path.join(bundle,d));}
 for(const [n,b] of Object.entries(made.artifacts))writeExclusive(path.join(bundle,n),b);
 writeExclusive(path.join(bundle,'launch.json'),JSON.stringify(made.description,null,2)+'\n');syncDir(bundle);syncDir(parent);
 return {bundle,digest:made.digest,launch:made.description.launch,scope:'Prepared only: no hardware, key read, signature or transaction.'};
}
export function verifyLaunchBundle({pins,bundle,expectedDigest,requireFresh=true}) {
 validateCaptureDirectory(bundle);need(/^[0-9a-f]{64}$/.test(expectedDigest??''),'reviewed package digest required');
 const p=path.join(bundle,'launch.json');const recordStat=regular(p,65536);need(recordStat.uid===process.getuid()&&(recordStat.mode&0o777)===0o600,'package record permissions differ');const actual=JSON.parse(fs.readFileSync(p,'utf8'));
 need(sha256hex(canonical(actual))===expectedDigest,'package description changed');
 const inputs=checkedInputs(pins),made=compile(pins,bundle,inputs);
 need(made.digest===expectedDigest,'current source, configuration or binary pins differ');
 need(fs.readdirSync(bundle).sort().join(',')===[...Object.keys(made.artifacts),'launch.json','state','capture','logs'].sort().join(','),'unexpected launch-package entry');
 for(const [name,body] of Object.entries(made.artifacts)){const f=path.join(bundle,name);const st=regular(f,262144);need(st.uid===process.getuid()&&(st.mode&0o777)===0o600,'artifact permissions differ');need(digestFile(f)===sha256hex(body),'artifact bytes changed');}
 for(const name of ['state','capture','logs']){const d=path.join(bundle,name);validateCaptureDirectory(d);if(requireFresh)need(fs.readdirSync(d).length===0,'state or capture is not fresh; explicit recovery procedure required');}
 return {bundle,digest:made.digest,launch:made.description.launch,runLabel:pins.runLabel,scope:'Files verified only; does not establish a live guest, ingress, memory availability or custody readiness.'};
}


function recoverySpec(pins,bundle,r) {
 const label=x=>/^\d{8}T\d{6}Z$/.test(x??''),hex=x=>/^[a-f0-9]{64}$/.test(x??'');
 need(r&&Object.keys(r).sort().join(',')==='committeeId,generation,mode,originBundle,originDigest,previous,stopped,version'&&r.version===1,'exact recovery specification required');
 need(label(pins.runLabel)&&label(r.generation)&&['restore','state-503'].includes(r.mode),'reviewed recovery generation and mode required');
 const origin=path.dirname(pins.custodian.captureDir),parent=path.dirname(origin),prev=r.previous;
 need(r.originBundle===origin&&path.basename(origin)==='r2-launch-'+pins.runLabel&&hex(r.originDigest),'original launch package required');
 need(prev&&Object.keys(prev).sort().join(',')==='bundle,digest,runLabel,runtimeDir'&&label(prev.runLabel)&&hex(prev.digest),'previous generation reference required');
 need(r.generation>prev.runLabel&&prev.runLabel>=pins.runLabel&&bundle===path.join(parent,'r2-recovery-'+r.generation),'recovery must advance to a distinct generation');
 need(prev.bundle===path.join(parent,(prev.runLabel===pins.runLabel?'r2-launch-':'r2-recovery-')+prev.runLabel)&&prev.runtimeDir===path.join(parent,'runtime-'+prev.runLabel),'previous paths are outside this run');
 need(prev.runLabel!==pins.runLabel||prev.digest===r.originDigest,'original predecessor digest differs');
 need(/^0x[0-9a-f]{64}$/.test(r.committeeId??'')&&!/^0x0{64}$/.test(r.committeeId)&&r.committeeId!==OLD_COMMITTEE_4774,'learned new committee required');
 const stopped=r.stopped;need(stopped&&Object.keys(stopped).sort().join(',')==='bootId,bundleDigest,invocation,recordHash,sealedState,unit'&&stopped.unit==='enclave-custody-r2-'+prev.runLabel+'.service'
  &&stopped.bundleDigest===prev.digest&&/^[a-f0-9]{32}$/.test(stopped.invocation)&&hex(stopped.recordHash)&&typeof stopped.bootId==='string','stopped predecessor binding differs');
 createRecoveryStateGate({file:path.join(origin,'state/state.bin'),expected:stopped.sealedState});
 return r;
}
export function recoveryReference({pins,originBundle,originDigest,previous,generation,mode,committeeId,stopped}) {
 need(stopped?.status==='stopped-verified'&&stopped.processesAbsent===true&&stopped.portsAbsent===true&&stopped.protectedServicesUnchanged===true,'actual stopped observation required');
 return {version:1,originBundle,originDigest,previous,generation,mode,committeeId,
  stopped:Object.fromEntries(['unit','invocation','bundleDigest','recordHash','bootId','sealedState'].map(k=>[k,stopped[k]]))};
}
export function stageRecoveryBundle({pins,parent,recovery}) {
 validateCaptureDirectory(parent);const bundle=path.join(parent,'r2-recovery-'+recovery.generation);recoverySpec(pins,bundle,recovery);
 need(!fs.existsSync(bundle),'recovery package already exists; never overwrite a generation');
 verifyLaunchBundle({pins,bundle:recovery.originBundle,expectedDigest:recovery.originDigest,requireFresh:false});
 const gate=createRecoveryStateGate({file:path.join(recovery.originBundle,'state/state.bin'),expected:recovery.stopped.sealedState});gate.read().fill(0);
 const made=compile(pins,bundle,checkedInputs(pins),recovery);
 fs.mkdirSync(bundle,{mode:0o700});fs.mkdirSync(path.join(bundle,'logs'),{mode:0o700});
 for(const [n,b] of Object.entries(made.artifacts))writeExclusive(path.join(bundle,n),b);
 writeExclusive(path.join(bundle,'launch.json'),JSON.stringify(made.description,null,2)+'\n');syncDir(bundle);syncDir(parent);
 return {bundle,digest:made.digest,runLabel:recovery.generation,launch:made.description.launch,scope:'Recovery files only. Original sealed state/capture/logs retained; no process, key read, signature or transaction.'};
}
export function verifyRecoveryBundle({pins,bundle,expectedDigest,requireFresh=true}) {
 validateCaptureDirectory(bundle);need(/^[a-f0-9]{64}$/.test(expectedDigest??''),'reviewed recovery digest required');
 const file=path.join(bundle,'launch.json'),st=regular(file,65536);need(st.uid===process.getuid()&&(st.mode&511)===384,'private recovery record required');
 const actual=JSON.parse(fs.readFileSync(file,'utf8'));need(actual.kind==='r2-capture-only-recovery'&&sha256hex(canonical(actual))===expectedDigest,'recovery description changed');
 const recovery=recoverySpec(pins,bundle,actual.recovery);
 verifyLaunchBundle({pins,bundle:recovery.originBundle,expectedDigest:recovery.originDigest,requireFresh:false});
 const made=compile(pins,bundle,checkedInputs(pins),recovery);need(made.digest===expectedDigest,'current recovery inputs differ');
 need(fs.readdirSync(bundle).sort().join(',')===[...Object.keys(made.artifacts),'launch.json','logs'].sort().join(','),'unexpected recovery entry');
 for(const [name,body] of Object.entries(made.artifacts)){const f=path.join(bundle,name),s=regular(f,262144);need(s.uid===process.getuid()&&(s.mode&511)===384&&digestFile(f)===sha256hex(body),'recovery artifact changed');}
 validateCaptureDirectory(path.join(bundle,'logs'));
 if(requireFresh){need(fs.readdirSync(path.join(bundle,'logs')).length===0,'recovery log generation is not fresh');createRecoveryStateGate({file:path.join(recovery.originBundle,'state/state.bin'),expected:recovery.stopped.sealedState}).read().fill(0);}
 return {bundle,digest:made.digest,runLabel:recovery.generation,recovery,launch:made.description.launch,scope:'Recovery file consistency only; live predecessor absence, authority and chain reconciliation still required before start.'};
}
