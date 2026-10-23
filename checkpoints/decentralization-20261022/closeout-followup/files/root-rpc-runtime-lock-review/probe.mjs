// Exercise the candidate's exact lock function with two real processes/filesystem.
// Pause owner between exclusive creation and write to expose a valid scheduling window.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const candidate = path.resolve(here, '../rpc-runtime-composition/repo/network/rpc-runtime.mjs');
if (!process.argv[2]) {
  const source = fs.readFileSync(candidate, 'utf8');
  const fn = source.slice(source.indexOf('function takeLock(file) {'), source.indexOf('// ---- the head path'));
  if (!fn.startsWith('function takeLock') || !fn.includes('fs.rmSync(file')) throw new Error('source boundary changed');
  fs.writeFileSync(path.join(here, 'frozen-takeLock.js'), fn);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-lock-review-'));
  const launch = role => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), role, dir], {stdio:['ignore','pipe','pipe']});
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    return {p, done: new Promise(resolve => p.on('exit', code => resolve({code,out,err})))};
  };
  const wait = async file => { for(let i=0;i<200;i++) {if(fs.existsSync(path.join(dir,file))) return; await new Promise(r=>setTimeout(r,10));} throw new Error('barrier timeout '+file); };
  const owner = launch('owner');
  await wait('created');
  const contender = launch('contender');
  await wait('contender-acquired');
  fs.writeFileSync(path.join(dir,'allow-owner-write'),'');
  await wait('owner-acquired');
  const result = {candidateSha256:createHash('sha256').update(source).digest('hex'),
    scope:'Exact lock function; two live processes, real filesystem. Controlled pause at exclusive-open/write boundary, not full RPC runtime.',
    simultaneousOwners:true, ownerPid:owner.p.pid, contenderPid:contender.p.pid,
    lockOnDisk:JSON.parse(fs.readFileSync(path.join(dir,'runtime.lock'),'utf8'))};
  fs.writeFileSync(path.join(dir,'finish'),'');
  result.children = await Promise.all([owner.done,contender.done]);
  fs.writeFileSync(path.join(here,'RESULT.json'),JSON.stringify(result,null,2)+'\n');
  fs.rmSync(dir,{recursive:true,force:true});
  console.log(JSON.stringify(result));
} else {
  const [role,dir] = process.argv.slice(2);
  const pauseUntil = file => {for(let i=0;i<1000;i++){if(fs.existsSync(path.join(dir,file)))return;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}throw new Error('timeout '+file);};
  const wrappedFs = {...fs, writeFileSync(file,body,opts){
    if(role==='owner' && file.endsWith('runtime.lock') && opts?.flag==='wx'){
      const fd=fs.openSync(file,'wx',opts.mode);
      fs.writeFileSync(path.join(dir,'created'),'');
      pauseUntil('allow-owner-write'); fs.writeFileSync(fd,body); fs.closeSync(fd); return;
    }
    return fs.writeFileSync(file,body,opts);
  }};
  const procIdentity = pid => {try {const s=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return {startTime:s.slice(s.lastIndexOf(')')+2).split(' ')[19]};}catch{return null;}};
  const takeLock=vm.runInNewContext(fs.readFileSync(path.join(here,'frozen-takeLock.js'),'utf8')+'\ntakeLock', {fs:wrappedFs,procIdentity,process,fail:m=>{throw new Error(m);}});
  const release=takeLock(path.join(dir,'runtime.lock'));
  fs.writeFileSync(path.join(dir,role+'-acquired'),'');
  pauseUntil('finish'); release(); console.log(role+' acquired');
}
