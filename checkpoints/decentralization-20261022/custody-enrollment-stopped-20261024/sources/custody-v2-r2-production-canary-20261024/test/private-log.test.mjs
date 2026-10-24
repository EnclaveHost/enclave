import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';import {spawn} from 'node:child_process';
import {attachCanaryLogs,inspectCanaryLogs,LOG_CAP} from '../driver/private-log.mjs';
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'custody-private-log-')));t.after(()=>fs.rmSync(dir,{recursive:true}));const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();const failures=[];const opts={dir,hostPid:123,hostStartTicks:'456',onFailure:()=>failures.push(true)};return {dir,child,opts,failures,inspect:extra=>inspectCanaryLogs({...opts,...extra})};}
test('real child streams are private and only hashes and provenance leave inspection',async t=>{
 const f=fixture(t),child=spawn(process.execPath,['-e',"process.stdout.write('synthetic-private-canary');process.stderr.write('synthetic-error');"],{stdio:['ignore','pipe','pipe']});
 attachCanaryLogs(child,f.opts);await new Promise((ok,no)=>{child.once('error',no);child.once('close',ok);});
 const r=f.inspect({requireComplete:true});assert.equal(r.status,'complete');assert.equal(r.total,39);assert.equal(fs.readFileSync(path.join(f.dir,'stdout.log'),'utf8'),'synthetic-private-canary');assert.ok(!JSON.stringify(r).includes('synthetic-private'));
 for(const name of fs.readdirSync(f.dir))assert.equal(fs.statSync(path.join(f.dir,name)).mode&0o777,0o600);
 assert.throws(()=>attachCanaryLogs(f.child,f.opts),/not fresh/);
});
test('aggregate stream cap fails once and never creates oversized output or a success record',t=>{
 const f=fixture(t);attachCanaryLogs(f.child,f.opts);f.child.stdout.write(Buffer.alloc(LOG_CAP-1,65));f.child.stderr.write(Buffer.from('B'));assert.equal(f.inspect().total,LOG_CAP);
 f.child.stderr.write(Buffer.from('C'));f.child.emit('close');f.child.emit('error',Error('synthetic private error'));assert.equal(f.failures.length,1);assert.equal(fs.statSync(path.join(f.dir,'stdout.log')).size+fs.statSync(path.join(f.dir,'stderr.log')).size,LOG_CAP);assert.throws(f.inspect,/capture failed/);
});
test('uncompleted, swapped, public, symlinked, hardlinked and other-generation logs cannot pass',t=>{
 const f=fixture(t);attachCanaryLogs(f.child,f.opts);assert.throws(()=>f.inspect({requireComplete:true}),/not completed/);assert.throws(()=>f.inspect({hostStartTicks:'789'}),/generation/);
 const p=path.join(f.dir,'stdout.log');fs.renameSync(p,p+'.old');fs.writeFileSync(p,'replacement',{mode:0o600});fs.unlinkSync(p+'.old');assert.throws(f.inspect,/replaced/);
 const g=fixture(t);attachCanaryLogs(g.child,g.opts);fs.chmodSync(path.join(g.dir,'stderr.log'),0o644);assert.throws(g.inspect,/private/);
 const h=fixture(t);attachCanaryLogs(h.child,h.opts);fs.linkSync(path.join(h.dir,'stdout.log'),path.join(h.dir,'outside-hardlink'));assert.throws(h.inspect);fs.unlinkSync(path.join(h.dir,'outside-hardlink'));fs.unlinkSync(path.join(h.dir,'stdout.log'));fs.symlinkSync(path.join(h.dir,'stderr.log'),path.join(h.dir,'stdout.log'));assert.throws(h.inspect,/private/);
 for(const x of [f,g,h])x.child.emit('close');
});
test('stream failure cannot be mistaken for complete and private errors are not serialized',t=>{
 const f=fixture(t);attachCanaryLogs(f.child,f.opts);f.child.stdout.emit('error',Error('synthetic-private-payload'));f.child.emit('close');assert.equal(f.failures.length,1);assert.throws(f.inspect,/capture failed/);assert.ok(!fs.readFileSync(path.join(f.dir,'closed.json'),'utf8').includes('payload'));
});
test('public or nonempty directories are rejected before stream output',t=>{
 const f=fixture(t);fs.chmodSync(f.dir,0o755);assert.throws(()=>attachCanaryLogs(f.child,f.opts),/private/);fs.chmodSync(f.dir,0o700);fs.writeFileSync(path.join(f.dir,'unrelated'),'do not touch');assert.throws(()=>attachCanaryLogs(f.child,f.opts),/not fresh/);assert.equal(fs.readFileSync(path.join(f.dir,'unrelated'),'utf8'),'do not touch');
});
