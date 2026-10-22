import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {lockRoot} from './enclave/scripts/site-release/root-state.mjs';
const root=fs.mkdtempSync(path.resolve('work/site-lock-helper-loss-'));
const children=pid=>fs.readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
const release=await lockRoot(root);
const helper=children(process.pid).find(pid=>fs.readFileSync(`/proc/${pid}/comm`,'utf8').trim()==='flock');
if(!helper)throw new Error('no owned flock helper');
const cat=children(helper).find(pid=>fs.readFileSync(`/proc/${pid}/comm`,'utf8').trim()==='cat');
if(!cat)throw new Error('no owned cat helper');
process.kill(cat,'SIGKILL');await sleep(100);
let acquired=false;try{const second=await lockRoot(root);acquired=true;await second();}catch{}
const result={parentStillAlive:true,firstReleaseCalled:false,helperChildKilled:cat,secondAcquired:acquired};
fs.writeFileSync('work/site-lock-helper-loss-repro.json',JSON.stringify(result,null,2)+'\n');console.log(result);
fs.rmSync(root,{recursive:true,force:true});
// Do not call the first release: its helper already closed, so its close listener would wait forever.
