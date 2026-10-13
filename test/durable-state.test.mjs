// DurableState's atomic write survives Windows' transient rename refusals (a reader holding the file open) and never
// leaves a temporary file behind when a rename finally fails (network/durable-state.mjs).
import test, {mock} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {DurableState} from '../network/durable-state.mjs';

const tmp=async t=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'durable-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;};
const busy=()=>Object.assign(new Error('EPERM: operation not permitted, rename'),{code:'EPERM'});

test('a rename refused while another process holds the file is retried and lands',async t=>{
 const dir=await tmp(t),s=new DurableState(dir),real=fs.rename;let refused=0;
 const m=mock.method(fs,'rename',async(a,b)=>{if(refused<2){refused++;throw busy();}return real(a,b);});t.after(()=>m.mock.restore());
 await s.set('routes',{v:1});
 assert.equal(refused,2);assert.deepEqual(await s.get('routes'),{v:1});
 assert.deepEqual(await fs.readdir(dir),['routes.json'],'no temporary left beside it');
});

test('a rename that keeps failing throws and removes its temporary; other errors are not retried',async t=>{
 const dir=await tmp(t),s=new DurableState(dir);let calls=0;
 const m=mock.method(fs,'rename',async()=>{calls++;throw busy();});t.after(()=>m.mock.restore());
 await assert.rejects(s.set('routes',{v:2}),/EPERM/);
 assert.ok(calls>1&&calls<=21,'bounded retries');assert.deepEqual(await fs.readdir(dir),[]);
 m.mock.restore();
 const n=mock.method(fs,'rename',async()=>{calls=0;throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});});t.after(()=>n.mock.restore());
 await assert.rejects(s.set('routes',{v:3}),/ENOSPC/);assert.equal(calls,0);assert.deepEqual(await fs.readdir(dir),[]);
});

test('an inPlace state overwrites the file where it stands when the rename stays refused, padding a shorter value',async t=>{
 const dir=await tmp(t),s=new DurableState(dir,{inPlace:true});
 await s.set('egress-routes',{apps:{a:'x'.repeat(200)}});
 let calls=0;const m=mock.method(fs,'rename',async()=>{calls++;throw busy();});t.after(()=>m.mock.restore());
 await s.set('egress-routes',{apps:{}});
 assert.ok(calls>1&&calls<=8,'a few retries, then in place');
 assert.deepEqual(await s.get('egress-routes'),{apps:{}});
 const raw=await fs.readFile(path.join(dir,'egress-routes.json'),'utf8');
 assert.equal(raw.trimEnd(),'{"apps":{}}','one write replaced every byte; the rest is whitespace');
 assert.deepEqual(await fs.readdir(dir),['egress-routes.json'],'no temporary left beside it');
 await s.set('egress-routes',{apps:{b:'y'.repeat(400)}});
 assert.deepEqual(await s.get('egress-routes'),{apps:{b:'y'.repeat(400)}},'a longer value grows the file');
 m.mock.restore();
 const n=mock.method(fs,'rename',async()=>{throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});});t.after(()=>n.mock.restore());
 await assert.rejects(s.set('egress-routes',{v:1}),/ENOSPC/,'only a refusal falls back');
});

test('the egress map writes in place; other state never does',async t=>{
 const {EgressMap}=await import('../network/egress-map.mjs');
 const e=new EgressMap({directory:await tmp(t),manager:{apps:new Map()},dns:[{address:'1.1.1.1:443',serverName:'x',path:'/dns-query'}]});
 assert.equal(e.state.inPlace,true);assert.equal(new DurableState(await tmp(t)).inPlace,false);
});
