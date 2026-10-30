// Actual linked local EVM + final owned composition. TEST finality, manager, readiness and transport; no production signer or hardware.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { useAnvil, mine, HOST, chainNow, step } from './fixtures/r5-world.mjs';
import { worldHR, ownerOffline } from './fixtures/host-registry-world.mjs';
import { fixture, route, PLATFORM } from './helpers/host-fixture.mjs';
import { realV2Host } from './helpers/real-v2-host.mjs';
import { openOwnedHostRegistryLifecycle } from '../network/lifecycle-host-owned-authority.mjs';
import { HOST_REGISTRY_PROFILE, HOST_REGISTRY_ARTIFACT_SHA256 } from '../network/lifecycle-host-registry-profile.mjs';
useAnvil();
async function setup(t){
 const w=await worldHR({payout:'owner'});await step(w,'queued','TEST owned enrollment');await mine();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-owned-'));const f=fixture({hostId:HOST,state:'queued',now:chainNow});f.V.ledger=w.contracts.legacyLedger.toLowerCase();
 const v2=realV2Host(w,{dir,host:HOST,now:chainNow}),R=w.pins.contracts.registry;
 const routes=[route(w.id,{oldLedger:f.V.ledger,newLedger:w.contracts.ledger.toLowerCase(),controller:w.contracts.lifecycle.toLowerCase(),lifecycleSchema:3,profile:HOST_REGISTRY_PROFILE,bundleSha256:w.adapter().bundleSha256,hostRegistry:R.address.toLowerCase(),hostRegistryCodeHash:R.codeHash,hostRegistryArtifactSha256:HOST_REGISTRY_ARTIFACT_SHA256,ledgerCodeHash:w.pins.contracts.ledger.codeHash,controllerCodeHash:w.pins.contracts.lifecycle.codeHash})];
 const parts={hostId:HOST,journalFile:path.join(dir,'parent.json'),incarnationFile:path.join(dir,'inc.json'),permitFile:path.join(dir,'permit.json'),pins:v2.pins,adapterPins:w.pins,...v2.components,routes,platformWallets:[PLATFORM],capacityHeadroom:0,verifyQuiescence:f.verifyQuiescence,now:chainNow,timeoutMs:150};
 const owned=[];const compose=async()=>{const c=await openOwnedHostRegistryLifecycle({...parts,adapter:w.adapter()});owned.push(c);c.dispatch.attach(f.hostView(HOST));await c.dispatch.activate();return c;};
 t.after(async()=>{for(const c of owned)await c.release('TEST cleanup');for(const x of v2.witnesses)await x.close();fs.rmSync(dir,{recursive:true,force:true});});
 return{w,v2,parts,compose,c:await compose()};
}
async function until(c,id,status){let r;for(let n=0;n<10;n++){r=await c.dispatch.reconcile(id);if(r.status===status)return r;await mine();}assert.fail(JSON.stringify({wanted:status,last:r}));}
test('NATIVE19 actual owned parent+sidecars start with signed permits; owner stop and pending history survive reopen without replay',async t=>{
 const {w,v2,c,parts,compose}=await setup(t),before=w.sent.length;
 await until(c,w.id,'running');assert.equal(w.sent.length,before+1);assert.ok(v2.calls.allow.length>0);assert.equal(v2.vms.size,1);
 const saved=c.journal.read(w.id);assert.ok(saved.runtime);assert.equal(c.hostAuthority.read(HOST).bound[w.id].kind,'fresh-queued-start');
 await assert.rejects(openOwnedHostRegistryLifecycle({...parts,adapter:w.adapter(),incarnationFile:parts.incarnationFile+'.other',permitFile:parts.permitFile+'.other'}));
 await c.dispatch.restrict(w.id,'TEST owner stops');await until(c,w.id,'queued');const sends=w.sent.length,allowed=v2.calls.allow.length;
 assert.equal((await c.release()).released,true);assert.equal(v2.vms.size,0);
 const reopened=await compose();await reopened.dispatch.reconcile(w.id);
 assert.equal(w.sent.length,sends);assert.equal(v2.calls.allow.length,allowed);assert.equal(reopened.journal.read(w.id).pending,null);
});
test('NATIVE19 canonical owner Offline removes real-gate TEST compute and survives owned composition restart',async t=>{
 const {w,v2,c,compose}=await setup(t);await until(c,w.id,'running');const before=v2.calls.allow.length;
 await ownerOffline(w);await mine();await c.dispatch.reconcile(w.id);
 assert.equal(v2.calls.allow.length,before);assert.equal(v2.vms.size,0);
 assert.equal(c.journal.readHostIncarnation(HOST).floor.offline.generation,'1');
 assert.equal((await c.release()).released,true);const reopened=await compose();await reopened.dispatch.reconcile(w.id);
 assert.equal(v2.calls.allow.length,before);assert.equal(reopened.journal.readHostIncarnation(HOST).floor.offline.generation,'1');
});
