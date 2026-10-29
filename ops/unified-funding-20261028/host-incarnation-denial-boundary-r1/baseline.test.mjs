// Root requirements tests against frozen prior sidecar. Not live-chain or runtime qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hostIncarnationSection} from './src/lifecycle-host-incarnation-journal.mjs';
import {hostIncarnationOf} from './src/lifecycle-host-profile.mjs';
const H=x=>'0x'+x.repeat(64), host=H('1');
function setup(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'root-offline-floor-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'journal.json');
 const context=(status='online',generation='1')=>hostIncarnationOf({registry:'0x'+'ab'.repeat(20),status,generation,qualificationDigest:H('2'),trustAnchorId:H('3'),hardwareId:H('4'),resourceDigest:H('5'),descriptorDigest:H('6')},{hostId:host,registryCodeHash:H('7')});
 return {file,context,j:hostIncarnationSection(file)};
}
test('same-generation Offline persists and older Online cannot erase denial',t=>{
 const {j,file,context}=setup(t);const online=context(),offline=context('offline');
 assert.equal(online.digest,offline.digest,'baseline incarnation intentionally excludes status');
 j.acceptHostIncarnation(host,online);j.acceptHostIncarnation(host,offline);
 assert.equal(j.readHostIncarnation(host).floor.context.status,'offline','accepted Offline must persist even without generation advance');
 const reopened=hostIncarnationSection(file);
 try {reopened.acceptHostIncarnation(host,online);} catch {}
 assert.equal(reopened.readHostIncarnation(host).floor.context.status,'offline','an older Online view cannot undo same-generation denial');
});
test('explicit new-generation recovery remains possible after Offline',t=>{
 const {j,context}=setup(t);j.acceptHostIncarnation(host,context('offline'));
 j.acceptHostIncarnation(host,context('online','2'));
 assert.equal(j.readHostIncarnation(host).floor.generation,'2');
 assert.equal(j.readHostIncarnation(host).floor.context.status,'online');
});
test('loss of an already observed journal remains unknown rather than fresh genesis',t=>{
 const {j,file,context}=setup(t);j.acceptHostIncarnation(host,context());j.readHostIncarnation(host);
 fs.unlinkSync(file);
 assert.throws(()=>j.readHostIncarnation(host),'missing observed state cannot become an empty journal');
});
test('malformed nested accepted floor is rejected',t=>{
 const {j,file,context}=setup(t);j.acceptHostIncarnation(host,context());
 const raw=JSON.parse(fs.readFileSync(file,'utf8'));raw.hosts[host].floor.context.generation='999';
 fs.writeFileSync(file,JSON.stringify(raw));
 assert.throws(()=>j.readHostIncarnation(host),'nested context must match accepted floor and digest');
});
test('directory fsync failure after rename stays unknown in the same process',t=>{
 const {j,context}=setup(t);const original=fs.fsyncSync;
 fs.fsyncSync=function(fd){if(fs.fstatSync(fd).isDirectory())throw Object.assign(new Error('owned injected directory fsync failure'),{code:'EIO'});return original(fd);};
 try {assert.throws(()=>j.acceptHostIncarnation(host,context()),/owned injected/);} finally {fs.fsyncSync=original;}
 assert.throws(()=>j.readHostIncarnation(host),'readback of renamed bytes must not turn failed durability into authorization');
});
