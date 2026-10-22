import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const file='work/storage-host-role/tree/network/host-services/storage-indexer-host.mjs';
const bytes=fs.readFileSync(file,'utf8');
const start=bytes.indexOf('export async function superviseReplica(');
const end=bytes.indexOf('\n/** Encrypted logical backup:',start);
assert.ok(start>=0 && end>start);
const source=bytes.slice(start,end).replace('export async function','async function');
let mode='refuse', unblock, pgStarts=0, pgStops=0;
const gate={start(){},stop(){},status(){return{};}};
const ctx=vm.createContext({
  console,Date,Promise,setTimeout,clearTimeout,setInterval,clearInterval,
  fs:{existsSync:()=>true},path:{join:(...x)=>x.join('/')},
  validateConfig:x=>x,dataDir:()=>'/fixture',
  admission:async()=>mode==='refuse'?{admit:false,reason:'fixture'}:new Promise(r=>{unblock=r;}),
  startPostgres:async()=>{pgStarts++;return {exitCode:null,signalCode:null};},
  stopChild:async c=>{if(c){c.exitCode=0;pgStops++;}},
  startIndexd:()=>new EventEmitter(),
});
vm.runInContext(source+'\nglobalThis.subject=superviseReplica;',ctx);
const sup=await ctx.subject({replica:'fixture',stateRoot:'/fixture',host:{endpoint:'https://fixture.invalid'}},{gate,log:()=>{},intervalMs:3600000});
mode='pending';
const tick=sup.tick();
await Promise.resolve();
assert.equal(typeof unblock,'function');
await sup.stop();
const startsWhenStopResolved=pgStarts;
unblock({admit:true,reason:'fixture admission',pkg:{}});
await tick;
const result={at:new Date().toISOString(),scope:'Exact candidate superviseReplica function with delayed admission and fake child processes; no production interaction',source:file,sourceSha256:createHash('sha256').update(bytes).digest('hex'),startsWhenStopResolved,startsAfterPendingAdmission:pgStarts,stops:pgStops,status:sup.status(),reproduced:pgStarts>startsWhenStopResolved};
await sup.stop();
fs.writeFileSync('outputs/decentralization-audit/storage-stop-race-reproduction.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
assert.equal(result.reproduced,true,'source changed: review whether the race has been repaired');
