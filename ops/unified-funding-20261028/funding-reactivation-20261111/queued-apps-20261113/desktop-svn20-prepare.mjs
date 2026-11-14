// SVN20 (08f69fa4...) activation files, made from the files that are live for SVN19 (the set prepared on
// 2026-11-13 in native-terminal-image-v15/activation, checked by hash) and the exported v16 candidate. Nothing here
// is activated by running this.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const SRC='/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source';
const {validateDesktopRelease,desktopRecordFor,deriveApprovedDesktop}=await import(SRC+'/relay/shield-desktop-release.mjs');
const {shieldImageCandidates}=await import(SRC+'/relay/shield-image-candidates.mjs');
const {validateDesktopAdmission}=await import(SRC+'/windows/vbslike/manager/desktop-admission.mjs');
const {validateDesktopPlatform}=await import(SRC+'/windows/vbslike/manager/desktop-platform.mjs');
const h=path.dirname(new URL(import.meta.url).pathname),w=path.dirname(path.dirname(h)),root=path.dirname(w);
const read=p=>JSON.parse(fs.readFileSync(p)),sha=b=>createHash('sha256').update(b).digest('hex');
const pinned=(p,want)=>{const b=fs.readFileSync(p);assert.equal(sha(b),want,p);return b};
const out=path.join(root,'outputs/kvm-box/native-platform-v16-moonlight-page'),c=read(path.join(out,'candidate.json'));
const CID=process.argv[2];assert.match(CID||'',/^baf[a-z2-7]{50,}$/,'usage: prepare.mjs <controller cid> <the SVN19 controller>');
const OLD_IGVM='de9e87e32cbacfa0dddb27422a36733dddadb3b87268aa14d7cc109bf9a1802e';
const live=path.join(w,'native-terminal-image-v15/activation');
const APP='0xcdc1fa941d248411e49f922e0bc7adfe8cc343712ca4fe4dfb24fab3ef6c70ce',DEPLOYMENT='0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b';
const PORTS='http:8000,tcp:47984,tcp:47989,tcp:48010,udp:47998,udp:47999,udp:48000';
assert.equal(c.guestSvn,20);assert.equal(c.signatureLocallyVerified,true);
// the live files
const oldPolicyRaw=pinned(path.join(live,'shield-policy.json'),'a0e735027bb3d04cfb037574485206673a7cda8f7b81eda73d43eac7d995e3ee'),old=JSON.parse(oldPolicyRaw);
const oldConfig=JSON.parse(pinned(path.join(live,'desktop-config.json'),'fc564428a4c50f108aaa6e70723c9216bf9652498efa6afa4ff177f866746440'));
const oldReleaseRaw=pinned(path.join(live,'desktop-release.json'),'fa61b80ac94710d5bc28759f3df65b20387eee04464ba74ac73aeaacca675b54');
let env=pinned(path.join(live,'native-desktop-env.cmd'),'f3c03189586ec51daa85441c508e6fc5b2bc74d156f702dfef094ca49baaa451').toString('utf8');
assert.deepEqual(JSON.parse(oldReleaseRaw),old.desktop);assert.equal(old.desktop.igvmSha256,OLD_IGVM);
const component=pinned(path.join(out,'shield-desktop.wasm'),c.controllerSha256);
const oldComponent=pinned(process.argv[3],old.desktop.controllerSha256);
// desktop-config.json
const target='C:\\ProgramData\\Enclave\\native-desktop\\releases\\'+c.files['native-igvm.bin'].sha256;
const oldTarget='C:\\ProgramData\\Enclave\\native-desktop\\releases\\'+OLD_IGVM;
assert.equal(oldConfig.imagePath,oldTarget+'\\native-igvm.bin');
const config=structuredClone(oldConfig);
config.imagePath=target+'\\native-igvm.bin';
Object.assign(config.platform,{igvmSha256:c.files['native-igvm.bin'].sha256,profileSha256:c.profileSha256,profileText:fs.readFileSync(path.join(out,'profile.json'),'utf8')});
assert.equal(sha(config.platform.profileText),c.profileSha256);
for(const media of config.platform.media){
 const f=c.files[media.role+'.iso'];
 for(const k of ['bytes','sha256','payloadBytes','payloadSha256','payloadOffset']){if(media.role==='models')assert.equal(media[k],f[k]);else media[k]=f[k]}
 if(media.role!=='models')media.path=target+'\\'+media.role+'.iso';
}
assert.equal(oldConfig.bridge.sha256,c.requiredBridgeSha256);
config.bridge={exe:target+'\\shielded-bridge.exe',sha256:c.requiredBridgeSha256};
const admission=validateDesktopAdmission({platform:config.platform,runtime:config.runtime});assert.equal(admission.platform.profileSha256,c.profileSha256);
validateDesktopPlatform(config.platform);
for(const k of ['runtime','workerPort','workerBudgetGb'])assert.deepEqual(config[k],oldConfig[k]);
assert.deepEqual(config.platform.media.find(m=>m.role==='models'),oldConfig.platform.media.find(m=>m.role==='models'));
// release and policy
const release=validateDesktopRelease({...old.desktop,controllerCid:CID,controllerSha256:c.controllerSha256,igvmSha256:c.files['native-igvm.bin'].sha256,profileSha256:c.profileSha256,launchMeasurement:c.vbsLaunchDigest.toLowerCase()});
assert.equal(release.runtimeId,c.runtimeId);
const prior=old.images.filter(x=>x.nativeDesktop);assert.equal(prior.length,1);assert.equal(prior[0].minimumGuestSvn,19);assert.equal(prior[0].igvmSha256,OLD_IGVM);
const image={...prior[0],measurement:release.launchMeasurement,igvmSha256:release.igvmSha256,profileSha256:c.profileSha256,controllerSha256:c.controllerSha256,identity:c.imageIdentity,minimumGuestSvn:20};
assert.deepEqual(image.identity,prior[0].identity);
const policy={...old,images:old.images.map(x=>x.nativeDesktop?image:x),desktop:release};
assert.deepEqual(shieldImageCandidates(policy,{runtimeId:c.runtimeId,requiresDesktop:true}),[image]);
const legacy=old.images.filter(x=>!x.nativeDesktop);assert.equal(legacy.length,12);
for(const p of legacy)assert.deepEqual(shieldImageCandidates(policy,{runtimeId:p.runtimeId}),shieldImageCandidates(old,{runtimeId:p.runtimeId}));
// the record the node derives: check the inputs against SVN19's known record (version 1) first, then catalog version 2
const req={release:old.desktop,app:APP,version:1,cid:old.desktop.controllerCid,memMiB:8192,ports:PORTS,deploymentId:DEPLOYMENT,cpuMilli:250,gpuMilli:500,config:{egress:'public-web',wasi:'0.2'}};
const before=deriveApprovedDesktop({release:old.desktop,record:desktopRecordFor(req),component:oldComponent});
assert.equal(before.appId,'cf5d46627e6f618f7aceeec25a8a61c3f7a9142858b3c4992a18ebbf44c2eca7');assert.equal(before.recordSha256,'8b06d2519b9549d3b72af495b90721d9f288bf68327a610187f88b8222c5e359');
const next=deriveApprovedDesktop({release,record:desktopRecordFor({...req,release,version:2,cid:CID}),component});
// write
const text=v=>JSON.stringify(v,null,2)+'\n',files={'desktop-config.json':text(config),'desktop-release.json':text(release),'shield-policy.json':text(policy),'derived.json':text({appId:next.appId,recordSha256:next.recordSha256,record:next.record})};
assert(env.includes(OLD_IGVM)&&env.includes('SVN19'));
env=env.replaceAll(OLD_IGVM,release.igvmSha256).replaceAll(sha(fs.readFileSync(path.join(live,'desktop-config.json'))),sha(files['desktop-config.json'])).replaceAll(sha(oldReleaseRaw),sha(files['desktop-release.json'])).replace('Native desktop SVN19 (owner terminal). Not hardware-qualified.','Native desktop SVN20 (page names the public Moonlight PC). Not hardware-qualified.');assert(env.includes('SVN20')&&!env.includes('SVN19'));
assert(!env.includes(OLD_IGVM)&&!env.includes('fc564428')&&!env.includes('fa61b80a'));
files['native-desktop-env.cmd']=env;
for(const [n,x] of Object.entries(files))fs.writeFileSync(path.join(h,n),x,{flag:'wx'});
const hashes=Object.fromEntries(Object.entries(files).map(([n,x])=>[n,sha(x)]));
const stage=Object.fromEntries(['native-igvm.bin','root.iso','hashes.iso','profile.json'].map(n=>[n,{bytes:c.files[n].bytes,sha256:c.files[n].sha256}]));
for(const n of ['desktop-config.json','desktop-release.json','native-desktop-env.cmd'])stage[n]={bytes:Buffer.byteLength(files[n]),sha256:hashes[n]};
stage['shielded-bridge.exe']={copyFrom:oldTarget+'\\shielded-bridge.exe',sha256:c.requiredBridgeSha256};
fs.writeFileSync(path.join(h,'prepared.json'),text({target,previousTarget:oldTarget,guestSvn:20,imageSha256:release.igvmSha256,profileSha256:release.profileSha256,launchMeasurement:release.launchMeasurement,controllerCid:CID,controllerSha256:release.controllerSha256,catalog:{app:APP,version:2,label:'0.9.2'},deployment:DEPLOYMENT,appId:next.appId,recordSha256:next.recordSha256,oldPolicySha256:sha(oldPolicyRaw),files:hashes,stage,legacyEntriesPreserved:12,hardwareVerificationPassed:false,activated:false}),{flag:'wx'});
console.log(JSON.stringify({prepared:true,appId:next.appId,files:hashes}));
