// Actual psrun/config modules; fake external child events, NO spawned process / PowerShell / Windows claim.
import test from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';import {EventEmitter} from 'node:events';import path from 'node:path';
const children=[];
globalThis.__owSpawn=(exe,args,options)=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>{c.killed=true;return true;};children.push({exe,args,options,c});return c;};
const target=new URL('./candidate/control/windows/vbslike/manager/psrun.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,n){if(s==='node:child_process'&&c.parentURL===target)return {url:'data:text/javascript,export const spawn=(...a)=>globalThis.__owSpawn(...a);',shortCircuit:true};return n(s,c);}});
const {powershellRunner}=await import(target);
const C=await import('./candidate/control/windows/node/operator-effects-config.mjs');
test.after(()=>{hooks.deregister();delete globalThis.__owSpawn;});
test('ROOT production configuration must use absolute PowerShell executable',async()=>{
 const run=C.ioOf().run(),p=run('TEST');const {exe,c}=children.at(-1);c.emit('close',0);await p;
 assert.equal(path.win32.isAbsolute(exe),true,'PATH lookup must not select storage probe executable');
});
test('ROOT PowerShell output cap is combined UTF8 bytes even for oversized multibyte chunk',async()=>{
 const p=powershellRunner({exe:'C:\\TEST\\powershell.exe',timeoutMs:100,maxOutputBytes:16})('TEST');
 const {c}=children.at(-1);c.stdout.emit('data',Buffer.from('😀'.repeat(32)));c.stderr.emit('data',Buffer.from('x'.repeat(100)));c.emit('close',0);
 const r=await p;assert.ok(Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)<=16,'combined retained output exceeded 16-byte cap');
});
test('ROOT timeout settles even when child ignores kill and never emits close',async()=>{
 let settled=false;const p=powershellRunner({exe:'C:\\TEST\\powershell.exe',timeoutMs:5,maxOutputBytes:64})('TEST').then(r=>{settled=true;return r;});
 const {c}=children.at(-1);await new Promise(r=>setTimeout(r,30));const before=settled;c.emit('close',0);const r=await p;
 assert.equal(before,true,'timeout waited indefinitely for close');assert.equal(r.code,124);
});
