// SVN21 (df63b626...) activation files, made from the files that are live for SVN20 (the set prepared on
// 2026-11-14 in native-page-image-v16/activation, checked by hash) and the exported v17 candidate. The controller,
// its CID and the catalog version (2) are SVN20's: the image is the only thing that changes, so there is no owner
// signature in this release. The node and the relay derive the desktop's app identity from the admitted release
// (network/desktop-expectation.mjs, relay/shield-app-verifier.mjs), so the identity changes with the policy.
// Nothing here is activated by running this.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const SRC='/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source';
const {validateDesktopRelease,desktopRecordFor,deriveApprovedDesktop}=await import(SRC+'/relay/shield-desktop-release.mjs');
const {shieldImageCandidates}=await import(SRC+'/relay/shield-image-candidates.mjs');
const {validateDesktopAdmission}=await import(SRC+'/windows/vbslike/manager/desktop-admission.mjs');
const {validateDesktopPlatform}=await import(SRC+'/windows/vbslike/manager/desktop-platform.mjs');
const h=path.dirname(new URL(import.meta.url).pathname),w=path.dirname(path.dirname(h)),root=path.dirname(w);
const read=p=>JSON.parse(fs.readFileSync(p)),sha=b=>createHash('sha256').update(b).digest('hex');
const pinned=(p,want)=>{const b=fs.readFileSync(p);assert.equal(sha(b),want,p);return b};
const out=path.join(root,'outputs/kvm-box/native-platform-v17-pair-again'),c=read(path.join(out,'candidate.json'));
const CID=process.argv[2];assert.match(CID||'',/^baf[a-z2-7]{50,}$/,'usage: prepare.mjs <controller cid>');
const OLD_IGVM='08f69fa415268c0211ec6867ad3b334aa62c56cb5bb8ed67257e876e9910747b';
const live=path.join(w,'native-page-image-v16/activation');
const APP='0xcdc1fa941d248411e49f922e0bc7adfe8cc343712ca4fe4dfb24fab3ef6c70ce',DEPLOYMENT='0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b';
const PORTS='http:8000,tcp:47984,tcp:47989,tcp:48010,udp:47998,udp:47999,udp:48000';
assert.equal(c.guestSvn,21);assert.equal(c.signatureLocallyVerified,true);
// the live files
const oldPolicyRaw=pinned(path.join(live,'shield-policy.json'),'54fed2c8eadd809770103ee63efdfd99540611efcfe0d99f3362b4f13c3ce60e'),old=JSON.parse(oldPolicyRaw);
const oldConfig=JSON.parse(pinned(path.join(live,'desktop-config.json'),'258006e76e565090cb7ce83504a85bc5eefe3f4dcecf4dcd0a0fa12280d55829'));
const oldReleaseRaw=pinned(path.join(live,'desktop-release.json'),'04a3e6c7230b2965d52ed40fdd1c457f892a54956ff642be6797df95903bafbd');
let env=pinned(path.join(live,'native-desktop-env.cmd'),'e74f25db96d148a7db57f99870b7964f1bcc1af4f1c25e9f83655e67facbe9b0').toString('utf8');
assert.deepEqual(JSON.parse(oldReleaseRaw),old.desktop);assert.equal(old.desktop.igvmSha256,OLD_IGVM);
const component=pinned(path.join(out,'shield-desktop.wasm'),c.controllerSha256);
assert.equal(old.desktop.controllerCid,CID);assert.equal(old.desktop.controllerSha256,c.controllerSha256);const oldComponent=component;
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
const prior=old.images.filter(x=>x.nativeDesktop);assert.equal(prior.length,1);assert.equal(prior[0].minimumGuestSvn,20);assert.equal(prior[0].igvmSha256,OLD_IGVM);
const image={...prior[0],measurement:release.launchMeasurement,igvmSha256:release.igvmSha256,profileSha256:c.profileSha256,controllerSha256:c.controllerSha256,identity:c.imageIdentity,minimumGuestSvn:21};
assert.deepEqual(image.identity,prior[0].identity);
const policy={...old,images:old.images.map(x=>x.nativeDesktop?image:x),desktop:release};
assert.deepEqual(shieldImageCandidates(policy,{runtimeId:c.runtimeId,requiresDesktop:true}),[image]);
const legacy=old.images.filter(x=>!x.nativeDesktop);assert.equal(legacy.length,12);
for(const p of legacy)assert.deepEqual(shieldImageCandidates(policy,{runtimeId:p.runtimeId}),shieldImageCandidates(old,{runtimeId:p.runtimeId}));
// the record the node derives: check the inputs against SVN20's known record first, then the same catalog version on SVN21
const req={release:old.desktop,app:APP,version:2,cid:CID,memMiB:8192,ports:PORTS,deploymentId:DEPLOYMENT,cpuMilli:250,gpuMilli:500,config:{egress:'public-web',wasi:'0.2'}};
const before=deriveApprovedDesktop({release:old.desktop,record:desktopRecordFor(req),component:oldComponent});
assert.equal(before.appId,'3d98424d9baf81a9d3f1c706b9d05d0a650ab1fcf8896724f8e14128de5e0659');assert.equal(before.recordSha256,'7c3c138046d457710687ac7f909f7ca43791b26a744c15de0cd6d873b8faa368');
const next=deriveApprovedDesktop({release,record:desktopRecordFor({...req,release}),component});
assert.notEqual(next.appId,before.appId);
// write
const text=v=>JSON.stringify(v,null,2)+'\n',files={'desktop-config.json':text(config),'desktop-release.json':text(release),'shield-policy.json':text(policy),'derived.json':text({appId:next.appId,recordSha256:next.recordSha256,record:next.record})};
assert(env.includes(OLD_IGVM)&&env.includes('SVN20'));
env=env.replaceAll(OLD_IGVM,release.igvmSha256).replaceAll(sha(fs.readFileSync(path.join(live,'desktop-config.json'))),sha(files['desktop-config.json'])).replaceAll(sha(oldReleaseRaw),sha(files['desktop-release.json'])).replace('Native desktop SVN20 (page names the public Moonlight PC). Not hardware-qualified.','Native desktop SVN21 (a Moonlight that pairs again stays paired). Not hardware-qualified.');
assert(!env.includes(OLD_IGVM)&&!env.includes('258006e7')&&!env.includes('04a3e6c7')&&env.includes('SVN21'));
files['native-desktop-env.cmd']=env;
for(const [n,x] of Object.entries(files))fs.writeFileSync(path.join(h,n),x,{flag:'wx'});
const hashes=Object.fromEntries(Object.entries(files).map(([n,x])=>[n,sha(x)]));
const stage=Object.fromEntries(['native-igvm.bin','root.iso','hashes.iso','profile.json'].map(n=>[n,{bytes:c.files[n].bytes,sha256:c.files[n].sha256}]));
for(const n of ['desktop-config.json','desktop-release.json','native-desktop-env.cmd'])stage[n]={bytes:Buffer.byteLength(files[n]),sha256:hashes[n]};
stage['shielded-bridge.exe']={copyFrom:oldTarget+'\\shielded-bridge.exe',sha256:c.requiredBridgeSha256};
fs.writeFileSync(path.join(h,'prepared.json'),text({target,previousTarget:oldTarget,guestSvn:21,imageSha256:release.igvmSha256,profileSha256:release.profileSha256,launchMeasurement:release.launchMeasurement,controllerCid:CID,controllerSha256:release.controllerSha256,catalog:{app:APP,version:2,label:'0.9.2'},deployment:DEPLOYMENT,appId:next.appId,recordSha256:next.recordSha256,previousAppId:before.appId,ownerSignatureNeeded:false,oldPolicySha256:sha(oldPolicyRaw),files:hashes,stage,legacyEntriesPreserved:12,hardwareVerificationPassed:false,activated:false}),{flag:'wx'});
console.log(JSON.stringify({prepared:true,appId:next.appId,files:hashes}));
