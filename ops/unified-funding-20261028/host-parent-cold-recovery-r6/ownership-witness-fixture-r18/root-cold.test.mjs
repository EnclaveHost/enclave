import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openOwnedLifecycleJournal } from '../network/lifecycle-host-owned-authority.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { openDurableState, openOwnedLock } from '../network/owned-durable-state.mjs';
const ID='0x'+'11'.repeat(32), OTHER='0x'+'22'.repeat(32), DIGEST='0x'+'33'.repeat(32);
const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'root-cold-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const opts={format:'ROOT-COLD-TEST',empty:{n:0},established:false,validate:x=>{assert.equal(typeof x.n,'number');return x;}};
test('ROOT15 established parent loss cannot become an empty new journal',async t=>{
 const f=path.join(tmp(t),'parent.json'),a=await openOwnedLifecycleJournal(f);
 a.journal.prepareTransition(ID,{digest:DIGEST,payload:'PUBLIC_TEST_PENDING'});a.release();fs.unlinkSync(f);
 let b;try{await assert.rejects(async()=>{b=await openOwnedLifecycleJournal(f);b.journal.read(ID);},/lost|missing|established/);}finally{b?.release();}
});
test('ROOT15 externally changed parent state is refused before any cached overwrite',async t=>{
 const f=path.join(tmp(t),'parent.json'),a=await openOwnedLifecycleJournal(f);t.after(()=>a.release());
 a.journal.prepareTransition(ID,{digest:DIGEST,payload:'PUBLIC_TEST_A'});
 openLifecycleJournal(f).prepareTransition(OTHER,{digest:DIGEST,payload:'PUBLIC_TEST_B'}); // TEST injected foreign write, not an authorized concurrent owner
 assert.throws(()=>a.journal.fence(ID,0),/changed|lost|uncertain/);
 assert.equal(openLifecycleJournal(f).read(OTHER).pending.payload,'PUBLIC_TEST_B');
});
function childStore(f){
 const module= new URL('../network/owned-durable-state.mjs',import.meta.url).href;
 const source=`import fs from 'node:fs';import {openOwnedLock,openDurableState} from ${JSON.stringify(module)};
 const f=${JSON.stringify(f)},o=await openOwnedLock(f);let armed=false,ack=false;
 const io={...fs,renameSync(a,b){if(armed&&a===f+'.commit')throw Error('TEST retraction failed');fs.renameSync(a,b);if(armed&&b===f+'.commit')ack=true;},
 openSync(p,...args){if(armed&&p===f+'.history')throw Error('TEST history unavailable');return fs.openSync(p,...args);},
 fsyncSync(fd){if(armed&&ack&&fs.fstatSync(fd).isDirectory())throw Error('TEST acknowledgement directory sync failed');return fs.fsyncSync(fd);}};
 const s=openDurableState(f,{format:'ROOT-COLD-TEST',empty:{n:0},established:false,owner:o,fsImpl:io,validate:x=>x});s.store({n:1});armed=true;
 try{s.store({n:2});throw Error('TEST expected injected failure');}catch(e){if(!/persistence uncertain/.test(e.message))throw e;}
 o.release();`;
 const r=spawnSync(process.execPath,['--max-old-space-size=64','--input-type=module','-e',source],{encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,r.stderr);
}
test('ROOT15 fresh process state with a visible ACK and failed failure-recording requires actual owned boot sync',async t=>{
 const f=path.join(tmp(t),'state.json');childStore(f);
 const o=await openOwnedLock(f);t.after(()=>o.release());const s=openDurableState(f,{...opts,owner:o});
 assert.deepEqual(s.state,{n:2});assert.equal(s.verification().seq,3);
 assert.match(fs.readFileSync(f+'.history','utf8'),/open-verified/);assert.equal(JSON.parse(fs.readFileSync(f+'.intent')).seq,3);
});
test('ROOT15 fresh process cannot use a visible ACK when owned boot sync fails',async t=>{
 const f=path.join(tmp(t),'state.json');childStore(f);
 const o=await openOwnedLock(f);t.after(()=>o.release());const io={...fs,fsyncSync(){throw Error('TEST fresh boot sync failed');}};
 const s=openDurableState(f,{...opts,owner:o,fsImpl:io});assert.throws(()=>s.state,/owned open verification failed/);
});

test('ROOT16 exact existing-parent import preserves pending bytes and requires an explicit matching digest',async t=>{
 const f=path.join(tmp(t),'parent.json');openLifecycleJournal(f).prepareTransition(ID,{digest:DIGEST,payload:'PUBLIC_TEST_EXISTING'});
 const bytes=fs.readFileSync(f),hash=createHash('sha256').update(bytes).digest('hex');
 await assert.rejects(openOwnedLifecycleJournal(f),/explicit exact importSha256/);
 await assert.rejects(openOwnedLifecycleJournal(f,{importSha256:'0'.repeat(64)}),/explicit exact importSha256/);
 const a=await openOwnedLifecycleJournal(f,{importSha256:hash});assert.equal(a.journal.read(ID).pending.payload,'PUBLIC_TEST_EXISTING');
 assert.deepEqual(fs.readFileSync(f),bytes);a.release();const b=await openOwnedLifecycleJournal(f);assert.deepEqual(b.journal.read(ID).pending,{digest:DIGEST,payload:'PUBLIC_TEST_EXISTING'});b.release();
});
test('ROOT16 first-use crash marker and changed provenance never synthesize a usable parent',async t=>{
 const f=path.join(tmp(t),'parent.json');fs.writeFileSync(f+'.parent-established',JSON.stringify({format:'enclave-owned-parent/v1',file:'parent.json'}));
 await assert.rejects(openOwnedLifecycleJournal(f),/established parent journal missing/);
 const g=path.join(tmp(t),'parent.json'),a=await openOwnedLifecycleJournal(g);t.after(()=>a.release());
 fs.writeFileSync(g+'.parent-established','{}');assert.throws(()=>a.journal.prepareTransition(ID,{digest:DIGEST,payload:'PUBLIC_TEST'}),/provenance changed/);
});
