import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..'),host=join(root,'shielded/anchor/avf/host');
const flags=['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-pthread'];
const env={...process.env,ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'};
test('native bridge refills and drains a wrapped buffer after a partial send',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-bridge-wrap-'));
 try {
  const bin=join(dir,'test');
  execFileSync('cc',[...flags,'-I',host,join(host,'native-bridge-wrap-test.c'),'-o',bin],{encoding:'utf8',timeout:60_000,env});
  const out=execFileSync(bin,[],{encoding:'utf8',timeout:5_000,env});
  assert.match(out,/partial send, wrapped refill and two-span drain exact PASS/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('native worker bridge: bounded bidirectional pump over socketpairs keeps bytes exact under backpressure, partial I/O and EINTR; half-close, cancel, no-progress deadline, non-socket refusal, dead sink, no descriptor left behind',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-bridge-'));
 try {
  for (const capacity of [1 << 20,4096,4099]) {
   const bin=join(dir,`test-${capacity}`);
   execFileSync('cc',[...flags,`-DBRIDGE_CAP=${capacity}`,'-I',host,join(host,'native-bridge-test.c'),'-o',bin],{encoding:'utf8',timeout:60_000,env});
   const out=execFileSync(bin,[],{encoding:'utf8',timeout:120_000,env});
   assert.match(out,/native-bridge: backpressure, partial I\/O, EINTR, half-close, cancel, no-progress deadline, non-socket refusal, dead sink, fd audit passed/);
   assert.match(out,/case 1: 25165824 \+ 12582912 bytes exact both ways/);
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('native bridge observes cancellation and idle deadlines during repeated read/send interruptions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-bridge-interrupt-'));
 try {
  const bin=join(dir,'test');
  execFileSync('cc',[...flags,'-I',host,join(host,'native-bridge-interrupt-test.c'),'-o',bin],{encoding:'utf8',timeout:60_000,env});
  const out=execFileSync(bin,[],{encoding:'utf8',timeout:5_000,env});
  for (const call of ['read','send']) for (const reason of ['cancel','idle deadline'])
   assert.ok(out.includes(`${call} EINTR: ${reason} observed`),out);
  assert.match(out,/native-bridge: interrupted read\/send preserve deadline and cancellation PASS/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('native bridge diagnostic accounts for the final bytes and splits call CPU from wall time',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-bridge-profile-'));
 try {
  const bin=join(dir,'test');
  execFileSync('cc',[...flags,'-I',host,join(host,'native-bridge-test.c'),'-o',bin],{encoding:'utf8',timeout:60_000,env});
  const run=spawnSync(bin,[],{encoding:'utf8',timeout:10_000,env:{...env,BRIDGE_TEST_N:'1048576',BRIDGE_TEST_STORM:'0',BRIDGE_TEST_PROFILE:'1'}});
  assert.equal(run.status,0,run.stderr);
  const rows=run.stderr.split('\n').filter(x=>x.startsWith('BRIDGE_SP ')).map(x=>Object.fromEntries([...x.matchAll(/(\w+)=(\d+)/g)].map(m=>[m[1],Number(m[2])])));
  assert.ok(rows.length>0);
  let up=0,down=0;
  for (const row of rows) {
   assert.equal(row.usage_available,1);
   assert.ok(row.dt>0 && row.cpu>0);
   const cpu=['cpu_read_guest','cpu_read_host','cpu_write_host','cpu_write_guest','cpu_poll'].reduce((s,k)=>{assert.ok(Number.isSafeInteger(row[k]) && row[k]>=0);return s+row[k];},0);
   assert.ok(cpu<=row.cpu+1_000_000,'call CPU exceeds whole-thread CPU');
   assert.ok(Math.abs(row.cpu_user+row.cpu_system-row.cpu)<2_000_000,'rusage disagrees with thread clock');
   if(up<1048576 || down<524288) {up+=row.up;down+=row.down;}
  }
  assert.equal(up,1048576);assert.equal(down,524288);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('native bridge caps only VM-bound sends while preserving both streams and cancellation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-bridge-cap-'));
 try {
  const bin=join(dir,'test');
  execFileSync('cc',[...flags,'-I',host,join(host,'native-bridge-test.c'),'-o',bin],{encoding:'utf8',timeout:60_000,env});
  const out=execFileSync(bin,[],{encoding:'utf8',timeout:10_000,env:{...env,BRIDGE_TEST_N:'4194304',BRIDGE_TEST_SMALL:'0',BRIDGE_TEST_WRITE_MAX:'4096'}});
  assert.match(out,/send cap: guest <= 4096; host maximum \d+; both streams exact PASS/);
  assert.match(out,/native-bridge: backpressure, partial I\/O, EINTR, half-close, cancel, no-progress deadline, non-socket refusal, dead sink, fd audit passed/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('native bridge IO metadata preserves real stream bytes, tracks exact offsets and exposes bounded truncation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-bridge-io-'));
 try {
  for (const cap of [131072,16]) {
   const bin=join(dir,`test-${cap}`);
   execFileSync('cc',[...flags,`-DANCHOR_IO_MAX=${cap}`,'-I',host,join(host,'native-bridge-test.c'),'-o',bin],{encoding:'utf8',timeout:60_000,env});
   const out=execFileSync(bin,[],{encoding:'utf8',timeout:10_000,env:{...env,BRIDGE_TEST_N:'4194304',BRIDGE_TEST_TRACE:'1'}});
   assert.match(out,/IO trace: exact offsets and transfer counters, bounded records, dropped=\d+ PASS/);
   if(cap===131072) assert.match(out,/dropped=0 PASS/);
   assert.match(out,/native-bridge: backpressure, partial I\/O, EINTR, half-close, cancel, no-progress deadline, non-socket refusal, dead sink, fd audit passed/);
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});
