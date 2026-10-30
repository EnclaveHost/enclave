// Read-only public-pin/journal validator. SOURCE ONLY: no run/lock/write/clear/import of production code.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const [entry,manifestPin,config,configPin]=process.argv.slice(1);
const H=/^[0-9a-f]{64}$/;
const RELEASE='93564093040d89309bbac1b7220e5000aef77f481b68d58a0a4e8ac10748c292';
const BOOT='8b749fa787ce991577ae9007b0c4cf2a884e5d3d362e8444b9fbc15736de3b25';
function safe(p){if(!/^[A-Za-z]:\\/.test(p))throw Error('not local absolute path');for(let q=p;;q=path.dirname(q)){if(fs.lstatSync(q).isSymbolicLink())throw Error('reparse point');if(path.dirname(q)===q)break;}}
function read(p,max){safe(p);const s=fs.lstatSync(p);if(!s.isFile()||s.nlink!==1||s.size<1||s.size>max)throw Error('file admission');const b=fs.readFileSync(p);if(b.length>max||b.length!==s.size)throw Error('read size changed');return b;}
if(process.platform!=='win32'||!H.test(manifestPin)||!H.test(configPin)||manifestPin!==RELEASE)throw Error('unexpected current release');
const base=path.dirname(entry);
if(path.basename(base)!==RELEASE||path.basename(entry)!=='bootstrap.mjs'||hash(read(entry,65536))!==BOOT)throw Error('entry pin differs');
const mf=path.join(base,'source-manifest.json'),mb=read(mf,65536);if(hash(mb)!==manifestPin)throw Error('manifest pin differs');const manifest=JSON.parse(mb);
const selected={};for(const rel of ['windows/vbslike/router/main.mjs','windows/vbslike/router/control.mjs','windows/vbslike/router/io.mjs','windows/vbslike/router/platform.mjs']){
 const b=read(path.join(base,'control',rel),262144),m=manifest.files?.[rel];if(!m||m.bytes!==b.length||m.sha256!==hash(b))throw Error('selected router source differs');selected[rel]=m.sha256;
}
const cb=read(config,65536);if(hash(cb)!==configPin)throw Error('config pin differs');const c=JSON.parse(cb);
if(Object.keys(c).sort().join(',')!=='journal,nativePins,schema'||c.schema!=='enclave-native-router/1'||c.journal!=='C:\\ProgramData\\Enclave\\native-router\\pending-launch.json')throw Error('unexpected public config schema/journal');
const raw=read(c.journal,1048576),txt=raw.toString('utf8');if(!txt.endsWith('\n'))throw Error('incomplete journal');
let previous=null,seq=0,last=null;
for(const line of txt.trimEnd().split('\n')){
 const r=JSON.parse(line);if(Object.keys(r).sort().join(',')!=='digest,previous,record,seq,state'||r.seq!==seq++||r.previous!==previous||!H.test(r.digest)||!['observed','pending'].includes(r.state))throw Error('journal chain/schema');
 const {digest,...data}=r;if(hash(JSON.stringify(data))!==digest)throw Error('journal hash');
 if(!last&&(r.state!=='observed'||r.record?.schema!=='enclave-router-journal/1'))throw Error('journal genesis');
 previous=digest;last=r;
}
if(!last)throw Error('empty journal');
let pendingPhysicalMiB=0;
if(last.state==='pending'){
 pendingPhysicalMiB=last.record?.expected?.physicalMiB;
 if(last.record?.schema!=='enclave-router-pending/1'||!Number.isSafeInteger(pendingPhysicalMiB)||pendingPhysicalMiB<0||pendingPhysicalMiB>84992)throw Error('pending physical reservation unknown');
}
// Re-read identical bytes after full validation. Any concurrent append or pin change refuses this observation.
if(!read(c.journal,1048576).equals(raw)||!read(config,65536).equals(cb)||!read(mf,65536).equals(mb))throw Error('observation changed');
console.log(JSON.stringify({entrySha256:BOOT,manifestSha256:manifestPin,configSha256:configPin,selectedSourceSha256:selected,journal:{lastState:last.state,physicalMiB:pendingPhysicalMiB,digest:last.digest},chainValidated:true,stableBytes:true,admissible:false}));
