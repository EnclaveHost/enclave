import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDurableState,openOwnedLock} from './network/owned-durable-state.mjs';
const opts={format:'ROOT-TEST',empty:{n:0},validate:x=>{assert.equal(typeof x.n,'number');return x;},established:false};
const dir=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'root-owned-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
test('control: real exclusive ownership and retained state',async t=>{
 const f=path.join(dir(t),'state.json'), owner=await openOwnedLock(f); t.after(()=>owner.release());
 const s=openDurableState(f,{...opts,owner});s.store({n:1});assert.equal(s.state.n,1);
 await assert.rejects(openOwnedLock(f,{timeoutMs:100}));s.release();assert.throws(()=>s.state,/released/);
 const next=await openOwnedLock(f);next.release();
});
test('async resource withdrawal must complete before another real flock owner enters',async t=>{
 const f=path.join(dir(t),'state.json'),owner=await openOwnedLock(f);t.after(()=>owner.release());
 const s=openDurableState(f,{...opts,owner});let unblock,done=false;
 const pending=new Promise(r=>{unblock=r;});s.onRelease(async()=>{await pending;done=true;});
 const releaseResult=s.release('ROOT shutdown');
 let next,acquired=false;try{next=await openOwnedLock(f,{timeoutMs:100});acquired=true;}catch{}finally{next?.release();}
 console.log('ROOT async ownership',JSON.stringify({acquired,done,releaseResult}));
 unblock();await pending;await Promise.resolve();
 assert.equal(acquired,false,'new ownership must wait for actual asynchronous resource withdrawal');
});
test('final intent-removal directory fsync ambiguity survives a new process-like open',async t=>{
 const f=path.join(dir(t),'state.json');let armed=false,count=0;
 const io={...fs,fsyncSync(fd){if(armed&&fs.fstatSync(fd).isDirectory()&&++count===3)throw Error('ROOT final removal dirsync failure');return fs.fsyncSync(fd);}};
 const s=openDurableState(f,{...opts,fsImpl:io});s.store({n:1});armed=true;
 assert.throws(()=>s.store({n:2}),/ROOT final removal/);assert.throws(()=>s.state,/uncertain/);s.release();
 const reopened=openDurableState(f,{...opts,established:true});
 console.log('ROOT reopen',JSON.stringify({intentPresent:fs.existsSync(f+'.intent'),failed:reopened.failed(),disk:JSON.parse(fs.readFileSync(f))}));
 assert.throws(()=>reopened.state,/uncertain|unknown/,'a fresh owner must not silently clear failed commit acknowledgement');
});
