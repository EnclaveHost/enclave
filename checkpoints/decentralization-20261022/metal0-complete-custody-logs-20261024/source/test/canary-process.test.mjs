import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {spawn} from 'node:child_process';import {watchCanaryGuest} from '../driver/canary-process.mjs';
const moduleURL=new URL('../driver/canary-process.mjs',import.meta.url).href;
function processRun(code){return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let out='',err='';
 const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('canary supervision test timed out'));},5000);
 child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',(status,signal)=>{clearTimeout(timer);resolve({status,signal,out,err});});
});}
test('real host process terminates after one child exit, including exit zero',async()=>{
 for(const status of [0,9]){
  const result=await processRun(`import {spawn} from 'node:child_process';import {watchCanaryGuest} from ${JSON.stringify(moduleURL)};
  process.stdout.write('one-launch\\n');const child=spawn(process.execPath,['-e','process.exit(${status})'],{stdio:'ignore'});
  watchCanaryGuest(child,{isStopping:()=>false});setTimeout(()=>process.stdout.write('host-kept-running\\n'),300);`);
  assert.equal(result.status,71);assert.equal(result.signal,null);assert.equal(result.out,'one-launch\n');assert.equal(result.err,'');
 }
});
test('real spawn failure is terminal and does not print private errors or launch again',async()=>{
 const result=await processRun(`import {spawn} from 'node:child_process';import {watchCanaryGuest} from ${JSON.stringify(moduleURL)};
 const child=spawn('/nonexistent/canary-private-fixture',{stdio:'ignore'});watchCanaryGuest(child,{isStopping:()=>false});setTimeout(()=>process.stdout.write('still-running'),300);`);
 assert.equal(result.status,71);assert.equal(result.out,'');assert.equal(result.err,'');
});
test('error followed by exit signals only once; graceful stop stays under the existing parent shutdown',()=>{
 const child=new EventEmitter(),exits=[],messages=[];const v=watchCanaryGuest(child,{isStopping:()=>false,exit:c=>exits.push(c),notify:m=>messages.push(m)});
 child.emit('error',Error('private child error'));child.emit('exit',42,'SIGTERM');assert.equal(v.terminal,true);assert.deepEqual(exits,[71]);assert.equal(messages.length,1);assert.ok(!JSON.stringify(messages).includes('private child'));
 const clean=new EventEmitter();watchCanaryGuest(clean,{isStopping:()=>true,exit:c=>exits.push(c)});clean.emit('exit',0,null);assert.deepEqual(exits,[71]);
});
test('a failing diagnostic callback cannot leave the host alive after child loss',()=>{
 const child=new EventEmitter(),exits=[];watchCanaryGuest(child,{isStopping:()=>false,exit:c=>exits.push(c),notify:()=>{throw Error('log failed');}});
 assert.throws(()=>child.emit('exit',1,null),/log failed/);assert.deepEqual(exits,[71]);
});
import {assertManualLifecycleRecord} from '../driver/cli.mjs';
test('restart cannot fall through to the ordinary release-log recorder and falsely pass without recovery evidence',()=>{
 assert.throws(()=>assertManualLifecycleRecord({id:'O.restart',expectRelease:{secretRev:2},expectRestart:true}),/live lifecycle verification/);
 assert.throws(()=>assertManualLifecycleRecord({id:'O.stopped',expectOutage:{custodian:'stopped'}}),/live lifecycle verification/);
 assert.throws(()=>assertManualLifecycleRecord({id:'O.timeout',expectOutage:{custodian:'state-503'}}),/live lifecycle verification/);
 assert.doesNotThrow(()=>assertManualLifecycleRecord({id:'C1.release.2',expectRelease:{secretRev:2}}));
});
