import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fixture,source,between,dep} from './linux-wallet-unknown/candidate/test/helpers/supervisor-wallet-fixture.mjs';
const f=fixture();const rec=f.serve(f.rec({status:'expired'}));
let resume;const paused=new Promise(r=>resume=r);
Object.assign(f.ctx,{ISOLATION_BACKEND:true,isolationHeldGuest:async()=>{await paused;return null;},vmHealth:async()=>null,isolationHeldSameRecord:()=>false,isolatedInference:()=>({}),neededVolumes:()=>[],CLAIM_TERMINAL:new Set(['expired','terminated','failed']),allocGpu:()=>null});
vm.runInContext(between('async function adopt(d, g, firewall, slice, { resume = false } = {}) {','\n// DIRECT_CLAIM_SELFTEST='),f.ctx);
const adopting=f.ctx.adopt(f.row(),{},[],{cpu:false},{resume:true});
// A teardown begins while adopt awaits its held-guest check; the old guest remains listed.
rec._stopPending={since:new Date().toISOString()};rec.status='terminated';
resume();await adopting;
const out={at:new Date().toISOString(),sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),oldGuestStillListed:f.s.instances.some(v=>v.id==='vm-1'),pendingStop:true,reservationFreed:f.s.events.includes('freeGpu'),recordRemoved:!f.ctx.deployments.has(dep),scope:'Actual complete adopt() body and real releaseGpu() from f1d0666b, scripted held-guest await/allocator; no production or actual VM.'};
fs.writeFileSync(new URL('root-linux-adopt-stop-race-result.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
