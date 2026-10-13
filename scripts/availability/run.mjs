#!/usr/bin/env node
// Explicit configuration module supplies wallet clients, peer trust and policy.
// Example: node scripts/availability/run.mjs /absolute/private/config.mjs --once
import path from 'node:path';import {pathToFileURL} from 'node:url';
import {openStore} from '../../availability/store.mjs';
import {runRound} from '../../availability/coordinator.mjs';
const file=process.argv[2];if(!file||!path.isAbsolute(file))throw new Error('absolute reviewed configuration module required');
const config=await import(pathToFileURL(file));
if(typeof config.configure!=='function')throw new Error('configuration must export configure(store)');
const store=await openStore(config.stateDirectory);let stopped=false;
process.on('SIGINT',()=>{stopped=true;});process.on('SIGTERM',()=>{stopped=true;});
try {
 const deps=await config.configure(store);
 if(!Number.isInteger(config.intervalSec)||config.intervalSec<1||config.intervalSec>60)throw new Error('intervalSec must be 1..60');
 do {
  try{const result=await runRound({...deps,store,nowSec:BigInt(Math.floor(Date.now()/1000))});
   console.log(JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v));}
  catch(e){console.error('round failed:',e.message);if(process.argv.includes('--once'))process.exitCode=1;}
  if(process.argv.includes('--once')||stopped)break;
  await new Promise(r=>setTimeout(r,config.intervalSec*1000));
 }while(!stopped);
}finally{await store.close();}
