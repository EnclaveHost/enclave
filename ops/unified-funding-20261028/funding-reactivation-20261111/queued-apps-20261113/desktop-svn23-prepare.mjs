// SVN23 (097affc3...) activation files, made from the files that are live for SVN22 (native-flow-image-v18/activation,
// checked by hash; the NucBox's own policy file and the relay's are both that policy, read 2026-11-20) and the
// exported v20 candidate. The controller, its CID and the catalog version label (0.9.2) are unchanged. What changes:
// the image, the release schema (enclave-desktop-release/2, no minimumCpuMilli: platform main b602b569a), and the
// deployment this desktop is for (0xf9bb979a of app 0x8e8a1340, bought at 17% CPU and 10% GPU). Nothing here is
// activated by running this.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const SRC='/home/steven/Projects/enclave';
const {validateDesktopRelease,desktopRecordFor,deriveApprovedDesktop}=await import(SRC+'/relay/shield-desktop-release.mjs');
const {shieldImageCandidates}=await import(SRC+'/relay/shield-image-candidates.mjs');
const {validateDesktopAdmission}=await import(SRC+'/windows/vbslike/manager/desktop-admission.mjs');
const {validateDesktopPlatform}=await import(SRC+'/windows/vbslike/manager/desktop-platform.mjs');
const h=path.dirname(new URL(import.meta.url).pathname),w=path.dirname(path.dirname(h)),root=path.dirname(w);
const read=p=>JSON.parse(fs.readFileSync(p)),sha=b=>createHash('sha256').update(b).digest('hex');
const pinned=(p,want)=>{const b=fs.readFileSync(p);assert.equal(sha(b),want,p);return b};
const out=path.join(root,'outputs/kvm-box/native-platform-v20-direct-route'),c=read(path.join(out,'candidate.json'));
const CID=process.argv[2];assert.match(CID||'',/^baf[a-z2-7]{50,}$/,'usage: prepare.mjs <controller cid>');
const OLD_IGVM='5022c649a295aa10ac4708eea601a771ce81d8f4eb399955335314eed56b6d4b';
const live=path.join(w,'native-flow-image-v18/activation');
const APP='0x8e8a1340ca7e9ea1490ce15295d722c3f5186db9e0d0f1094661dbe919d8208c',DEPLOYMENT='0xf9bb979ae685c7f16f6c49df3f35f76ff38aca86b5ce3e76e02b83115360dd58';
const PORTS='http:8000,tcp:47984,tcp:47989,tcp:48010,udp:47998,udp:47999,udp:48000';
assert.equal(c.guestSvn,23);assert.equal(c.signatureLocallyVerified,true);
const oldPolicyRaw=pinned(path.join(live,'shield-policy.json'),'d202746f943486a7239f5180a0811dd35fbaab35fa11c1fbdf56f8e756349e62'),old=JSON.parse(oldPolicyRaw);
const oldConfig=JSON.parse(pinned(path.join(live,'desktop-config.json'),'292d32fd39dfe830e70542b29b97ff81e170a8e98b5709d8fe5845ffea6bbb2d'));
const oldReleaseRaw=pinned(path.join(live,'desktop-release.json'),'e521bcc6161afdbab8bca187287f042f1597fabcdf482409c220bef9524f8e33');
let env=fs.readFileSync(path.join(live,'native-desktop-env.cmd'),'utf8');
assert.deepEqual(JSON.parse(oldReleaseRaw),old.desktop);assert.equal(old.desktop.igvmSha256,OLD_IGVM);assert.equal(old.desktop.schema,'enclave-desktop-release/1');
const component=pinned(path.join(out,'shield-desktop.wasm'),c.controllerSha256);
assert.equal(old.desktop.controllerCid,CID);assert.equal(old.desktop.controllerSha256,c.controllerSha256);
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
// release (schema /2: the old block without minimumCpuMilli) and policy
const {minimumCpuMilli,...carried}=old.desktop;assert.equal(minimumCpuMilli,250);
const release=validateDesktopRelease({...carried,schema:'enclave-desktop-release/2',controllerCid:CID,controllerSha256:c.controllerSha256,igvmSha256:c.files['native-igvm.bin'].sha256,profileSha256:c.profileSha256,launchMeasurement:c.vbsLaunchDigest.toLowerCase()});
assert.equal(release.runtimeId,c.runtimeId);assert.equal(release.schema,'enclave-desktop-release/2');assert(!('minimumCpuMilli' in release));
assert.deepEqual(release.policy,old.desktop.policy);
const prior=old.images.filter(x=>x.nativeDesktop);assert.equal(prior.length,1);assert.equal(prior[0].minimumGuestSvn,22);assert.equal(prior[0].igvmSha256,OLD_IGVM);
const image={...prior[0],measurement:release.launchMeasurement,igvmSha256:release.igvmSha256,profileSha256:c.profileSha256,controllerSha256:c.controllerSha256,identity:c.imageIdentity,minimumGuestSvn:23};
assert.deepEqual(image.identity,prior[0].identity);
const policy={...old,images:old.images.map(x=>x.nativeDesktop?image:x),desktop:release};
assert.deepEqual(shieldImageCandidates(policy,{runtimeId:c.runtimeId,requiresDesktop:true}),[image]);
const legacy=old.images.filter(x=>!x.nativeDesktop);assert.equal(legacy.length,12);
// every other image answers as before: asked of the new policy and of the old one without its desktop block (this
// code refuses the old /1 block, which is why the relay, the node and the manager change with the policy)
const oldBare={...old};delete oldBare.desktop;oldBare.images=legacy;
for(const p of legacy)assert.deepEqual(shieldImageCandidates(policy,{runtimeId:p.runtimeId}),shieldImageCandidates(oldBare,{runtimeId:p.runtimeId}));
assert.throws(()=>validateDesktopRelease(old.desktop));
// the record the node derives for the queued deployment, at the shares it was bought with
const req={release,app:APP,version:2,cid:CID,memMiB:8192,ports:PORTS,deploymentId:DEPLOYMENT,cpuMilli:170,gpuMilli:100,config:{egress:'public-web',wasi:'0.2'}};
const next=deriveApprovedDesktop({release,record:desktopRecordFor(req),component});
assert.equal(next.record.desktop.gpuMilli,100);
// write
const text=v=>JSON.stringify(v,null,2)+'\n',files={'desktop-config.json':text(config),'desktop-release.json':text(release),'shield-policy.json':text(policy),'derived.json':text({appId:next.appId,recordSha256:next.recordSha256,record:next.record})};
assert(env.includes(OLD_IGVM)&&env.includes('SVN22'));
env=env.replaceAll(OLD_IGVM,release.igvmSha256).replaceAll(sha(fs.readFileSync(path.join(live,'desktop-config.json'))),sha(files['desktop-config.json'])).replaceAll(sha(oldReleaseRaw),sha(files['desktop-release.json'])).replace(/^rem Native desktop SVN22.*$/m,'rem Native desktop SVN23 (any purchased share; the OpenCL llama route through executor sessions). Not hardware-qualified.');
assert(!env.includes(OLD_IGVM)&&!env.includes('292d32fd')&&!env.includes('e521bcc6')&&env.includes('SVN23')&&!env.includes('SVN22'));
files['native-desktop-env.cmd']=env;
for(const [n,x] of Object.entries(files))fs.writeFileSync(path.join(h,n),x,{flag:'wx'});
const hashes=Object.fromEntries(Object.entries(files).map(([n,x])=>[n,sha(x)]));
const stage=Object.fromEntries(['native-igvm.bin','root.iso','hashes.iso','profile.json'].map(n=>[n,{bytes:c.files[n].bytes,sha256:c.files[n].sha256}]));
for(const n of ['desktop-config.json','desktop-release.json','native-desktop-env.cmd'])stage[n]={bytes:Buffer.byteLength(files[n]),sha256:hashes[n]};
stage['shielded-bridge.exe']={copyFrom:oldTarget+'\\shielded-bridge.exe',sha256:c.requiredBridgeSha256};
fs.writeFileSync(path.join(h,'prepared.json'),text({target,previousTarget:oldTarget,guestSvn:23,imageSha256:release.igvmSha256,profileSha256:release.profileSha256,launchMeasurement:release.launchMeasurement,controllerCid:CID,controllerSha256:release.controllerSha256,catalog:{app:APP,version:2,label:'0.9.2'},deployment:DEPLOYMENT,purchased:{cpuMilli:170,gpuMilli:100},appId:next.appId,recordSha256:next.recordSha256,ownerSignatureNeeded:false,releaseSchema:release.schema,hostBundle:{version:'2026.11.20',commit:'b602b569a8d6cdce522fee7ded74acd8b510b238',zipSha256:'01c7255d9a2c88624155320ee5b9050738de6bb7c6604e10e169f782fbf240f7'},oldPolicySha256:sha(oldPolicyRaw),files:hashes,stage}),{flag:'wx'});
console.log(JSON.stringify({prepared:true,appId:next.appId,recordSha256:next.recordSha256,files:hashes}));
