import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {openStore} from '../availability/store.mjs';
const linux=process.platform==='linux';
const fresh=async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-lock-'));return {dir,lock:path.join(dir,'.lock')};};
const leave=async(lock,owner)=>{await fs.mkdir(lock);if(owner!==undefined)await fs.writeFile(path.join(lock,'owner'),owner);};
const deadPid=()=>spawnSync(process.execPath,['-e','']).pid;
const own=async()=>{const stat=await fs.readFile('/proc/self/stat','utf8');
 return {start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],boot:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()};};

test('a running owner keeps its lock, and close gives it back',async()=>{
 const {dir}=await fresh();const store=await openStore(dir);
 try{await assert.rejects(openStore(dir),{code:'EEXIST'});}finally{await store.close();}
 await (await openStore(dir)).close();await fs.rm(dir,{recursive:true});
});
test('a lock whose owner is gone is taken over',{skip:!linux},async()=>{
 const me=await own();
 for(const owner of [`${deadPid()}\n`,`${deadPid()} 123 ${me.boot}\n`,`${process.pid} ${me.start} 00000000-0000-0000-0000-000000000000\n`,`${process.pid} ${BigInt(me.start)+1n} ${me.boot}\n`]){
  const {dir,lock}=await fresh();await leave(lock,owner);const store=await openStore(dir);
  assert.equal((await fs.readFile(path.join(lock,'owner'),'utf8')).trim(),`${process.pid} ${me.start} ${me.boot}`);
  assert.deepEqual((await fs.readdir(dir)).filter(x=>x.includes('stale')),[]);
  await store.close();await fs.rm(dir,{recursive:true});
 }
});
test('a lock that cannot be told to be stale is refused',{skip:!linux},async()=>{
 const me=await own();
 for(const owner of [undefined,'','not a pid\n','0\n',`${process.pid}\n`,`${process.pid} ${me.start} ${me.boot}\n`,`${process.pid} ${me.start}\n`]){
  const {dir,lock}=await fresh();await leave(lock,owner);
  await assert.rejects(openStore(dir),{code:'EEXIST'},JSON.stringify(owner));
  await fs.rm(dir,{recursive:true});
 }
});
