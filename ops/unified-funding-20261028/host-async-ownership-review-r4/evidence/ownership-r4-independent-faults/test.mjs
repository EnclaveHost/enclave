import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openDurableState,openOwnedLock} from './network/owned-durable-state.mjs';
const opts={format:'ROOT-TEST',empty:{n:0},validate:x=>{assert.equal(typeof x.n,'number');return x;},established:false};
const dir=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'root-r4-fault-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
test('control clean owned write and exact record preserved',async t=>{const f=path.join(dir(t),'x'),owner=await openOwnedLock(f);t.after(()=>owner.release());const s=openDurableState(f,{...opts,owner});s.store({n:7});assert.equal(s.state.n,7);const result=await s.release();assert.equal(result.released,true);});
test('failed final commit sync plus failed retraction cannot reopen clean',async t=>{
 const f=path.join(dir(t),'x');let armed=false,n=0;
 const io={...fs,fsyncSync(fd){if(armed&&fs.fstatSync(fd).isDirectory()&&++n===3)throw Error('ROOT final ack fsync');return fs.fsyncSync(fd);},renameSync(src,dst){if(armed&&src===f+'.commit')throw Error('ROOT retraction failure');return fs.renameSync(src,dst);}};
 const s=openDurableState(f,{...opts,fsImpl:io});s.store({n:1});armed=true;assert.throws(()=>s.store({n:2}),/retraction ALSO failed/);await s.release();
 const next=openDurableState(f,{...opts,established:true});console.log('ROOT double-fault reopen',next.failed());assert.throws(()=>next.state,/uncertain|unknown/);
});
test('missing intent cannot be replaced by a new intent describing current bytes',async t=>{
 const f=path.join(dir(t),'x'),s=openDurableState(f,opts);s.store({n:1});await s.release();fs.unlinkSync(f+'.intent');
 const next=openDurableState(f,{...opts,established:true});assert.throws(()=>next.state,/intent/);assert.throws(()=>next.recover(),/intent|evidence|unknown/);assert.equal(fs.existsSync(f+'.intent'),false,'lost provenance cannot be synthesized');
});
test('reentrant release during withdrawal must not release actual flock early',async t=>{
 const f=path.join(dir(t),'x'),owner=await openOwnedLock(f);t.after(()=>owner.release());const s=openDurableState(f,{...opts,owner});let unblock,inner;const deferred=new Promise(r=>{unblock=r;});
 s.onRelease(()=>{inner=s.release('reentrant');return deferred;});const outer=s.release('outer');let next,entered=false;
 try{next=await openOwnedLock(f,{timeoutMs:100});entered=true;}catch{}finally{next?.release();}
 unblock();await outer;console.log('ROOT reentrant',JSON.stringify({entered,same:inner===outer}));assert.equal(entered,false);assert.equal(inner,outer,'one completion published before callbacks');
});
