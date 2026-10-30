// The Linux supervisor's host-wallet decisions on its REAL caller paths (fixture: test/helpers/supervisor-wallet-fixture.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import net from 'node:net';
import {once} from 'node:events';
import {source,fixture,blockQueue,appFunded,sleep,host,dep,app,catalog,ref,owner} from './helpers/supervisor-wallet-fixture.mjs';

test('known allow: the audit keeps serving and the due renewal is sent once, under its decision deadline',{timeout:20_000},async()=>{
 const f=fixture();const r=f.serve(f.rec());
 await f.audit();assert.deepEqual(f.s.events,[]);assert.equal(r.status,'running');assert.equal(r.walletHeld,undefined);
 r._leaseUntil=Math.floor(Date.now()/1000)+60;f.s.lease=r._leaseUntil;
 await f.ctx.renewLeases();
 assert.deepEqual(f.s.writes,['renew']);assert.equal(r._leaseUntil,f.s.lease+1800);assert.deepEqual(f.releases(),[]);
});

test('explicit refusal - the platform administrator yanks the version, or the host owner denies the deployment: retired and released as before',{timeout:20_000},async()=>{
 for(const [why,set] of [['yank',w=>{w.catalog={...w.catalog,yanked:true};}],['owner',w=>{w.doc={...w.doc,denyDeployments:[dep]};w.revision=2;}]]){
  for(const action of ['audit','renew']){
   const f=fixture();set(f.w);const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
   if(action==='audit')await f.audit();else await f.ctx.renewLeases();
   assert.deepEqual(f.s.events,['stop','freeGpu','prove+release'],`${why}/${action}: freed only after the CONFIRMED stop, then released`);assert.equal(r.status,'terminated');
   assert.equal(r.walletHeld,undefined,'a definite refusal is no hold');assert.deepEqual(f.s.writes,[],'never renewed');
  }
 }
 const f=fixture();f.w.catalog={...f.w.catalog,yanked:true};
 const g=await f.ctx.gateAppReference(ref,{deploymentId:dep});assert.equal(g.error.status,403);assert.equal(g.error.code,'not_approved');
});

test('unknown (RPC quorum unavailable): stopped here, never renewed or released, on the audit AND the renewal path; the gate answers 503',{timeout:20_000},async()=>{
 for(const action of ['audit','renew']){
  const f=fixture();f.w.down=true;const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  if(action==='audit')await f.audit();else await f.ctx.renewLeases();
  assert.deepEqual(f.s.events,['stop','freeGpu'],`${action}: stopped (confirmed: slice freed), nothing released`);assert.deepEqual(f.s.writes,[],`${action}: nothing sent`);
  assert.equal(r.status,'terminated');assert.match(r.walletHeld.why,/chain quorum unavailable/);assert.equal(r.walletHeld.stopConfirmed,true);
  assert.match(r.error,/lease is kept \(not renewed or released\)/);
 }
 const f=fixture();f.w.down=true;
 const g=await f.ctx.gateAppReference(ref,{deploymentId:dep});
 assert.equal(g.error.status,503,'unknown is the try-again answer, not a refusal');assert.equal(g.error.code,'wallet_policy_unavailable');
});

test('unknown never releases through the share-resize eviction or claims/resumes in tryClaim',{timeout:20_000},async()=>{
 const f=fixture();f.w.down=true;f.s.resize=true;const r=f.serve(f.rec());
 await f.ctx.switchTenantVersion(r,f.row({cpuMilli:200}));
 assert.deepEqual(f.s.events,[],'the resize is deferred (transient), not evicted with a release');assert.match(r.versionChange.error,/unavailable/);
 for(const resume of [false,true]){
  const t=fixture();t.w.down=true;
  const why=await t.ctx.tryClaim(t.row(),{wasmRef:'catalog'},[],{},{hinted:true,resume});
  assert.match(why,/host wallet policy unavailable/);assert.deepEqual(t.s.writes,[]);assert.deepEqual(t.s.adopted,[],`resume=${resume}: nothing adopted`);
 }
 const t=fixture();
 assert.equal(await t.ctx.tryClaim(t.row({leaseUntil:0n,runner:'0x'+'00'.repeat(32)}),{wasmRef:'catalog'},[],{},{hinted:true}),undefined);
 assert.deepEqual(t.s.writes,['claim'],'allowed: one claim');assert.deepEqual(t.s.adopted,['claim']);
});

test('no unsolicited release on unknown across repeated passes; the held id is not vouched for (its guest is not kept alive)',{timeout:20_000},async()=>{
 const f=fixture();f.w.down=true;f.s.stopOk=false;const r=f.serve(f.rec());
 f.ctx._ownLeases=new Map([[dep,f.s.lease]]);
 await f.audit();assert.equal(r.walletHeld.stopConfirmed,false,'an unconfirmed stop');
 assert.deepEqual([...f.ctx.unresumedOwnLeases()],[],'held: never vouched for as an unresumed lease, so the reconciler ends that guest');
 for(let i=0;i<5;i++){await f.audit();await f.ctx.renewLeases();}
 assert.deepEqual(f.releases(),[]);assert.deepEqual(f.s.writes,[]);
 assert.equal(f.s.events.filter(e=>e==='stop').length,6,'the unconfirmed stop is retried every pass');
});

test('expiry: a decision that passes its chain deadline in the operator queue is not sent; a held lease that lapses is simply let go',{timeout:20_000},async()=>{
 const f=fixture();f.w.authorityAge=89_800;   // the decision lives ~200 ms
 const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
 let open;f.ctx._txChain=new Promise(res=>{open=res;});   // an earlier operator transaction still in flight
 const pass=f.ctx.renewLeases();await sleep(500);open();await pass;
 assert.deepEqual(f.s.writes,[],'superseded at the send: nothing signed');assert.deepEqual(f.releases(),[]);
 assert.equal(r.status,'running');assert.ok(!(r._renewBackoffUntil>Date.now()),'no failure backoff: the next round decides afresh');
 const h=fixture();h.w.down=true;const held=h.serve(h.rec());await h.audit();
 h.s.lease=Math.floor(Date.now()/1000)-5;await h.audit({leaseUntil:BigInt(h.s.lease)});
 assert.equal(held.walletHeld,undefined,'nothing left to hold');assert.equal(held.status,'terminated');
 await h.ctx.renewLeases();assert.deepEqual(h.s.writes,[],'never re-claimed by the renewal path');assert.deepEqual(h.releases(),[]);
});

test('recovery: the policy becomes known again - allowed: the hold clears and the lease is resumable; refused: released as a retire (no final proof)',{timeout:20_000},async()=>{
 const f=fixture();f.w.down=true;const r=f.serve(f.rec());f.ctx._ownLeases=new Map([[dep,f.s.lease]]);
 await f.audit();assert.ok(r.walletHeld);
 f.w.down=false;await f.audit();
 assert.equal(r.walletHeld,undefined);assert.deepEqual(f.releases(),[]);assert.deepEqual(f.s.writes,[]);
 assert.deepEqual([...f.ctx.unresumedOwnLeases()],[dep],'vouched again: the claim sweep resumes it');
 assert.equal((await f.ctx.gateAppReference(ref,{deploymentId:dep})).error,undefined,'the resume gate passes');
 assert.equal(await f.ctx.tryClaim(f.row(),{wasmRef:'catalog'},[],{},{hinted:true,resume:true}),undefined);
 assert.deepEqual(f.s.adopted,['resume'],'resumed without a transaction');assert.deepEqual(f.s.writes,[]);
 const g=fixture();g.w.down=true;const h=g.serve(g.rec());await g.audit();
 g.w.down=false;g.w.catalog={...g.w.catalog,yanked:true};await g.audit();
 assert.deepEqual(g.s.events,['stop','freeGpu','release'],'refused after the hold: released, nothing proven for the held time');
 const refusal=(await g.w.admission.decision({deploymentId:dep,appRef:ref,forPrivate:false})).refusal;assert.ok(refusal);
 assert.equal(h.walletHeld,undefined);assert.equal(h.error,refusal,'the platform moderation refusal, verbatim');
});

test('in-flight race: a renewal decided ALLOWED waits in the operator queue, an audit meanwhile finds the policy unknown: nothing is sent (app-funded and operator-paid senders)',{timeout:20_000},async()=>{
 for(const appFunded of [true,false]){
  const f=fixture();const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  if(appFunded){f.ctx.leaseGasActive=()=>true;f.ctx.leaseGasError=(fn,id,e)=>e;
   f.ctx.leaseGasSender=()=>({renew:async()=>{f.s.writes.push('sponsored renew');return {hash:'0x'+'bb'.repeat(32),receipt:{status:'success',blockNumber:7n}};}});}
  let open;f.ctx._txChain=new Promise(res=>{open=res;});
  const pass=f.ctx.renewLeases();await sleep(50);   // decided (allowed) and queued
  f.w.down=true;await f.audit({leaseUntil:BigInt(r._leaseUntil)});assert.ok(r.walletHeld);
  open();await pass;
  assert.deepEqual(f.s.writes,[],`appFunded=${appFunded}: the queued renewal is superseded by the hold`);
  assert.deepEqual(f.releases(),[]);assert.equal(r.status,'terminated');
  if(appFunded){   // control: the same sponsored sender does renew when nothing intervenes
   const c=fixture();c.ctx.leaseGasActive=()=>true;c.ctx.leaseGasError=(fn,id,e)=>e;
   c.ctx.leaseGasSender=()=>({renew:async()=>{c.s.writes.push('sponsored renew');return {hash:'0x'+'bb'.repeat(32),receipt:{status:'success',blockNumber:7n}};}});
   c.serve(c.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));await c.ctx.renewLeases();assert.deepEqual(c.s.writes,['sponsored renew']);
  }
 }
});

test('an older admission bundle (refusal() only, no decision()) is held as unknown, loudly - never read as allowed, never released',{timeout:20_000},async()=>{
 const f=fixture();const old=f.w.admission;f.ctx.__old={hostId:old.hostId,refusal:q=>old.refusal(q)};
 vm.runInContext('_hostWalletAdmission=__old',f.ctx);const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
 await f.audit();await f.ctx.renewLeases();
 assert.deepEqual(f.s.events,['stop','freeGpu']);assert.deepEqual(f.s.writes,[]);assert.match(r.walletHeld.why,/no decision\(\) \(an older bundle/);
 assert.equal((await f.ctx.gateAppReference(ref,{deploymentId:dep})).error.status,503);
});

// ---- root review 1: a queued permission never outlives a withdrawal ------------------------------------------------
test('review 1: a VERIFIED refusal voids a renewal already queued under an earlier allow (operator-paid and app-funded)',{timeout:20_000},async()=>{
 for(const sponsored of [false,true]){
  const f=fixture();if(sponsored)appFunded(f);const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  const open=blockQueue(f);const pass=f.ctx.renewLeases();await sleep(50);   // allowed and queued
  f.w.catalog={...f.w.catalog,yanked:true};await f.audit({leaseUntil:BigInt(r._leaseUntil)});   // the administrator's yank: retired
  open();await pass;
  assert.deepEqual(f.s.writes,[],`sponsored=${sponsored}: the old permission sends nothing and spends no reserve gas`);
  assert.ok(f.s.events.includes('prove+release'),'the refusal itself is enforced (released)');assert.equal(r.walletHeld,undefined);
 }
});
test('review 1: hold -> fresh allow cannot resurrect an earlier permission, even when the SAME record object serves again',{timeout:20_000},async()=>{
 for(const sponsored of [false,true]){
  const f=fixture();if(sponsored)appFunded(f);const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  const open=blockQueue(f);const pass=f.ctx.renewLeases();await sleep(50);
  f.w.down=true;await f.audit({leaseUntil:BigInt(r._leaseUntil)});assert.ok(r.walletHeld);
  f.w.down=false;await f.audit({leaseUntil:BigInt(r._leaseUntil)});assert.equal(r.walletHeld,undefined,'allowed again: hold cleared');
  r.status='running';   // as if the resume reused this very object (walletHeld cleared, status back): the boolean alone would pass
  open();await pass;
  assert.deepEqual(f.s.writes,[],`sponsored=${sponsored}: superseded by the epoch, not by a flag`);
  r._renewing=false;await f.ctx.renewLeases();   // control: a renewal DECIDED after the recovery goes out
  assert.equal(f.s.writes.length,1,'a fresh decision renews');
 }
});
test('review 1: owner stop, a restart (re-provision) and a replaced record each void a queued renewal',{timeout:20_000},async()=>{
 for(const change of ['owner-stop','restart','replace']){
  const f=fixture();const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  const open=blockQueue(f);const pass=f.ctx.renewLeases();await sleep(50);
  if(change==='owner-stop')await f.audit({leaseUntil:BigInt(r._leaseUntil),active:false});
  if(change==='restart'){await f.ctx.provisionTenant(r);assert.equal(r.status,'running','serving again after the restart');}
  if(change==='replace')f.ctx.deployments.set(dep,{...r});
  open();await pass;assert.deepEqual(f.s.writes,[],`${change}: nothing sent`);
 }
});
test('review 1: a renewal that reaches the queue WHILE an owner stop is still waiting for its DELETE is not sent (revoked before the await)',{timeout:20_000},async()=>{
 for(const sponsored of [false,true]){
  const f=fixture();if(sponsored)appFunded(f);const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  const open=blockQueue(f);const pass=f.ctx.renewLeases();await sleep(50);
  let answer;f.s.deleteGate=new Promise(res=>{answer=res;});
  const stopping=f.audit({leaseUntil:BigInt(r._leaseUntil),active:false});await sleep(30);
  assert.equal(r.status,'terminated','the owner-stop path withdrew service BEFORE its DELETE answers');
  open();await pass;   // the queued renewal runs NOW, mid-stop
  assert.deepEqual(f.s.writes,[],`sponsored=${sponsored}: stopContainer revoked it synchronously`);
  answer();await stopping;
 }
});
test('review 1: app-funded - a hold that lands while the sponsored client is still admitting relays stops the SIGNED lease before any relay',{timeout:20_000},async()=>{
 const f=fixture();appFunded(f,{delayMs:300});const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
 const pass=f.ctx.renewLeases();await sleep(60);   // the queue's gate already passed; the client is inside its relay work
 f.w.down=true;await f.audit({leaseUntil:BigInt(r._leaseUntil)});assert.ok(r.walletHeld);
 await pass;
 assert.deepEqual(f.s.writes,[],'signed, given to no relay: the reserve pays nothing');
 assert.ok(!(r._renewBackoffUntil>Date.now()),'superseded, not a relay failure');
});
test('review 1: a claim decided ALLOWED is voided by a later refusal for that deployment from any caller (no local record to revoke)',{timeout:20_000},async()=>{
 const t=fixture();const open=blockQueue(t);
 const p=t.ctx.tryClaim(t.row({leaseUntil:0n,runner:'0x'+'00'.repeat(32)}),{wasmRef:'catalog'},[],{},{hinted:true});await sleep(50);
 t.w.catalog={...t.w.catalog,yanked:true};assert.ok((await t.ctx.hostWalletDecision(dep,ref,false)).refusal);
 open();await p;assert.deepEqual(t.s.writes,[]);assert.deepEqual(t.s.adopted,[]);
});

// ---- root review 2: a failed stop is not isolation ---------------------------------------------------------------
test('review 2: on a FAILED stop service is withdrawn at once (routes, open streams, egress, permits), the slice stays reserved and nothing resumes or replaces it until the backend confirms the guest gone',{timeout:30_000},async()=>{
 const f=fixture();const r=f.serve(f.rec());f.ctx._ownLeases=new Map([[dep,f.s.lease]]);
 // a REAL established stream into the deployment (an upgrade socket the data path handed over)
 const srv=net.createServer(sock=>{f.ctx.trackDeploymentStream(dep,sock);});srv.listen(0,'127.0.0.1');await once(srv,'listening');
 const client=net.connect(srv.address().port,'127.0.0.1');client.on('error',()=>{});await once(client,'connect');await sleep(30);
 let release;f.s.deleteGate=new Promise(res=>{release=res;});f.s.stopOk=false;f.w.down=true;
 const closed=once(client,'close');const pass=f.audit();await sleep(50);   // the guest's DELETE has not answered yet
 assert.equal(r.status,'terminated','withdrawn BEFORE the stop answers: every ingress admits only running records');
 await Promise.race([closed,sleep(2000).then(()=>{throw Error('the established stream was NOT cut');})]);
 assert.deepEqual(f.s.egressClosed,[dep],'its egress connections were closed');assert.ok(r._leaseEpoch>=1,'its lease permissions revoked');
 release();await pass;srv.close();
 assert.deepEqual(f.s.events,['stop'],'no slice freed on a failed stop');assert.ok(r._gpu,'the slice stays reserved');
 assert.ok(r._stopPending);assert.equal(r.walletHeld.stopConfirmed,false);assert.match(r.error,/NOT confirmed stopped/);
 assert.match(await f.ctx.tryClaim(f.row(),{wasmRef:'catalog'},[],{},{hinted:true,resume:true}),/not confirmed stopped/);
 assert.deepEqual(f.s.adopted,[],'no resume onto hardware the old guest may still hold');
 f.w.down=false;await f.audit();assert.ok(r.walletHeld,'allowed again, but the hold stays until the stop is confirmed');
 assert.deepEqual([...f.ctx.unresumedOwnLeases()],[],'still not vouched for');
 f.s.stopOk=true;f.s.keepListed=true;await f.audit();
 assert.ok(r.walletHeld&&r._stopPending,'DELETE answered 200 but the listing still shows the guest: not confirmed');
 assert.equal(f.s.events.filter(e=>e==='freeGpu').length,0);
 f.s.instances=[];f.ctx.settlePendingStops(f.s.instances);   // the reconciler's listing no longer names it
 assert.deepEqual(f.s.events.filter(e=>e==='freeGpu'),['freeGpu'],'freed exactly once, on confirmation');
 assert.equal(r._stopPending,undefined);assert.equal(r.walletHeld.stopConfirmed,true);
 await f.audit();assert.equal(r.walletHeld,undefined,'confirmed and allowed: the hold clears');
 assert.equal(await f.ctx.tryClaim(f.row(),{wasmRef:'catalog'},[],{},{hinted:true,resume:true}),undefined);assert.deepEqual(f.s.adopted,['resume']);
 assert.deepEqual(f.releases(),[],'and through all of it the lease was never released');
});
test('review 2: an administrator refusal with a FAILED stop still releases the lease, but the slice waits for the confirmed stop',{timeout:20_000},async()=>{
 const f=fixture();const r=f.serve(f.rec());f.s.stopOk=false;f.w.catalog={...f.w.catalog,yanked:true};
 await f.audit();
 assert.deepEqual(f.s.events,['stop','prove+release'],'the ban is enforced; no slice freed');assert.ok(r._gpu&&r._stopPending);assert.equal(r.status,'terminated');
 f.w.catalog={...f.w.catalog,yanked:false};   // even once the version is admitted again, nothing reclaims this id onto its slice
 assert.match(await f.ctx.tryClaim(f.row({leaseUntil:0n,runner:'0x'+'00'.repeat(32)}),{wasmRef:'catalog'},[],{},{hinted:true}),/not confirmed stopped/);
 assert.deepEqual(f.s.writes,[]);assert.deepEqual(f.s.adopted,[]);
 f.s.listOk=false;f.ctx.settlePendingStops(null);assert.ok(r._stopPending,'an unreadable listing confirms nothing');
 f.ctx.settlePendingStops([]);assert.ok(f.s.events.includes('freeGpu'));assert.equal(r._stopPending,undefined);
});

// ---- root review 3 (decision window): a permit is bound to its DECISION, never rebased at gate construction ----------
const unclaimed=f=>f.row({leaseUntil:0n,runner:'0x'+'00'.repeat(32)});
const slowOpen=f=>{let release;const gate=new Promise(r=>{release=r;});f.ctx.openForUs=async()=>{await gate;return true;};return ()=>release();};
test('decision window: tryClaim decides ALLOWED, openForUs is slow, another caller gets a REFUSAL meanwhile: neither sender dispatches the claim',{timeout:20_000},async()=>{
 for(const sponsored of [false,true]){
  const t=fixture();if(sponsored)appFunded(t,{claim:true});const done=slowOpen(t);
  const p=t.ctx.tryClaim(unclaimed(t),{wasmRef:'catalog'},[],{},{hinted:true});await sleep(50);   // decided (allowed), now in openForUs
  t.w.catalog={...t.w.catalog,yanked:true};assert.ok((await t.ctx.hostWalletDecision(dep,ref,false)).refusal,'a separate admission call: refused');
  t.w.catalog={...t.w.catalog,yanked:false};   // and admitted again before the claim's gate is even built
  done();await p;
  assert.deepEqual(t.s.writes,[],`sponsored=${sponsored}: the pre-refusal allow is never rebased onto the newer count`);assert.deepEqual(t.s.adopted,[]);
 }
});
test('decision window: the same with an UNKNOWN answer in between (RPC outage seen by another caller): no dispatch',{timeout:20_000},async()=>{
 const t=fixture();const done=slowOpen(t);
 const p=t.ctx.tryClaim(unclaimed(t),{wasmRef:'catalog'},[],{},{hinted:true});await sleep(50);
 t.w.down=true;assert.ok((await t.ctx.hostWalletDecision(dep,ref,false)).unknown);t.w.down=false;
 done();await p;assert.deepEqual(t.s.writes,[]);
});
test('decision window: an OLD in-flight allow that returns after a newer refusal is read again; a fresh allow then stands, a second overlap is unknown',{timeout:20_000},async()=>{
 // (a) overlap once: the re-read is a FRESH decision started after the refusal -> the claim goes out (fresh-allow recovery)
 { const t=fixture();let release;t.w.holdNextRead=new Promise(r=>{release=r;});
   const p=t.ctx.tryClaim(unclaimed(t),{wasmRef:'catalog'},[],{},{hinted:true});await sleep(50);   // its catalog read observed "allowed" and is held
   t.w.catalog={...t.w.catalog,yanked:true};assert.ok((await t.ctx.hostWalletDecision(dep,ref,false)).refusal);
   t.w.catalog={...t.w.catalog,yanked:false};release();
   assert.equal(await p,undefined);assert.deepEqual(t.s.writes,['claim'],'claimed under the re-read, fresh allow');assert.ok(t.w.reads>=3,'the overlapped read was repeated'); }
 // (b) the re-read overlaps again -> answered unknown: nothing claimed
 { const t=fixture();let r1,r2;t.w.holdNextRead=new Promise(r=>{r1=r;});
   const p=t.ctx.tryClaim(unclaimed(t),{wasmRef:'catalog'},[],{},{hinted:true});await sleep(50);
   t.w.catalog={...t.w.catalog,yanked:true};await t.ctx.hostWalletDecision(dep,ref,false);t.w.catalog={...t.w.catalog,yanked:false};
   t.w.holdNextRead=new Promise(r=>{r2=r;});r1();await sleep(50);   // the re-read is now in flight and held
   t.w.catalog={...t.w.catalog,yanked:true};await t.ctx.hostWalletDecision(dep,ref,false);t.w.catalog={...t.w.catalog,yanked:false};r2();
   assert.match(await p,/overlapped a refusal or an unavailable answer/);assert.deepEqual(t.s.writes,[]); }
 // (c) control: a claim decided AFTER a refusal (fresh allow) is not blocked by that earlier refusal
 { const t=fixture();t.w.catalog={...t.w.catalog,yanked:true};await t.ctx.hostWalletDecision(dep,ref,false);t.w.catalog={...t.w.catalog,yanked:false};
   assert.equal(await t.ctx.tryClaim(unclaimed(t),{wasmRef:'catalog'},[],{},{hinted:true}),undefined);assert.deepEqual(t.s.writes,['claim']); }
});
test('decision window: a renewal permit is bound BEFORE the ledger read - a retire during that read is never rebased (both senders)',{timeout:20_000},async()=>{
 for(const sponsored of [false,true]){
  const f=fixture();if(sponsored)appFunded(f);const r=f.serve(f.rec({_leaseUntil:Math.floor(Date.now()/1000)+60}));
  let release;const slow=new Promise(x=>{release=x;});const read=f.ctx.readLedgerContract;f.ctx.readLedgerContract=async(...a)=>{await slow;return read(...a);};
  const pass=f.ctx.renewLeases();await sleep(30);   // permit taken, ledger read in flight
  f.w.catalog={...f.w.catalog,yanked:true};f.ctx.readLedgerContract=read;await f.audit({leaseUntil:BigInt(r._leaseUntil)});   // retired
  f.w.catalog={...f.w.catalog,yanked:false};r.status='running';   // even if the record read "running" again
  release();await pass;
  assert.deepEqual(f.s.writes,[],`sponsored=${sponsored}: no renewal for a record retired after its permit was taken`);
 }
});

// ---- the other teardown paths: withdrawn first, slice only on a confirmed stop, each path's own LEASE rule kept --------
test('teardown paths on a FAILED stop: owner stop, lost lease, eviction, abandoned claims, ledger move - routes/egress/permits withdrawn first, slice kept, lease rule unchanged',{timeout:30_000},async()=>{
 const cases={
  'owner-stop':async f=>f.audit({active:false}),
  'lease-lost':async f=>{await f.audit({runner:'0x'+'99'.repeat(32),leaseUntil:BigInt(Math.floor(Date.now()/1000)+3600)});await f.audit({runner:'0x'+'99'.repeat(32),leaseUntil:BigInt(Math.floor(Date.now()/1000)+3600)});},
  'evict':async f=>{f.s.resize=true;f.ctx.gateAppReference=async()=>({error:{status:403,msg:'not servable at the new size'}});await f.ctx.switchTenantVersion(f.ctx.deployments.get(dep),f.row({cpuMilli:200}));},
  'abandon':async f=>f.ctx.abandonClaims('this enclave is unreachable'),
  'ledger-move':async f=>{f.s.ledgerMoved=true;await f.ctx.ledgerMoveSweep();},
 };
 const releases={'owner-stop':['prove+release'],'lease-lost':[],'evict':['prove+release'],'abandon':['prove+release'],'ledger-move':[]};
 const statuses={'owner-stop':'terminated','lease-lost':'expired','evict':'expired','abandon':'expired','ledger-move':'terminated'};
 for(const [name,run] of Object.entries(cases)){
  const f=fixture();const r=f.serve(f.rec());f.s.stopOk=false;let answer;f.s.deleteGate=new Promise(x=>{answer=x;});
  const p=run(f);await sleep(40);
  assert.equal(r.status,statuses[name],`${name}: withdrawn before the DELETE answers`);assert.ok(r._stopPending,`${name}: pending during the DELETE`);
  assert.deepEqual(f.s.egressClosed,[dep],`${name}: egress closed`);assert.ok(r._leaseEpoch>=1);
  answer();await p;
  assert.ok(r._gpu,`${name}: slice kept on a failed stop`);assert.equal(f.s.events.filter(e=>e==='freeGpu').length,0);
  assert.deepEqual(f.releases(),releases[name],`${name}: its own lease rule`);
  assert.match(await f.ctx.tryClaim(f.row(),{wasmRef:'catalog'},[],{},{hinted:true,resume:true}),/not confirmed stopped/,`${name}: no resume/replacement`);
  f.s.instances=[];f.ctx.settlePendingStops(f.s.instances);assert.equal(f.s.events.filter(e=>e==='freeGpu').length,1,`${name}: freed once, on confirmation`);
 }
});
test('teardown path on a CONFIRMED stop frees the slice at once (owner stop control)',{timeout:20_000},async()=>{
 const f=fixture();const r=f.serve(f.rec());await f.audit({active:false});
 assert.deepEqual(f.s.events,['stop','freeGpu','prove+release']);assert.equal(r._stopPending,undefined);assert.equal(r._gpu,null);
});
test('restart and accounting: a pending stop survives loadState with its slice re-reserved, reconcilePools keeps it, confirmation frees it once',{timeout:20_000},async()=>{
 const f=fixture();
 const held={id:dep,status:'terminated',_onchain:true,_vmId:'vm-1',_gpu:{cpu:true,share:0.25},_stopPending:{since:'t0'},walletHeld:{why:'x',stopConfirmed:false}};
 const gone={id:'0x'+'ee'.repeat(32),status:'terminated',_onchain:true,_gpu:{cpu:true,share:0.25}};   // a confirmed teardown's stale handle
 f.s.stateJson=JSON.stringify({savedAt:Date.now(),deployments:[held,gone]});
 f.ctx.loadState();
 const rh=f.ctx.deployments.get(dep),rg=f.ctx.deployments.get(gone.id);
 assert.ok(rh._gpu&&rh._stopPending,'the pending slice is restored');assert.equal(rg._gpu,null,'a stale handle on a confirmed teardown is dropped');
 assert.equal(f.ctx.cpuPool.shareFree,0.75,'and re-reserved: 0.25 of the share ledger stays taken');
 assert.deepEqual([...f.ctx.reconcilePools()],[],'the pool reconciler sees no drift: the pending slice is held, not leaked');
 assert.ok(rh._gpu);assert.equal(f.ctx.cpuPool.shareFree,0.75);
 f.ctx.settlePendingStops([{id:'vm-1',name:dep,status:'running'}]);assert.ok(rh._stopPending,'still listed: still pending');
 f.ctx.settlePendingStops([]);assert.equal(f.ctx.cpuPool.shareFree,1,'freed exactly once');assert.equal(rh.walletHeld.stopConfirmed,true);
 f.ctx.settlePendingStops([]);assert.equal(f.ctx.cpuPool.shareFree,1);
});

test('source: every Linux lease send on a wallet decision carries its gate, and no caller folds unknown into a refusal',()=>{
 assert.equal(source.includes('hostWalletRefusal'),false);
 for(const s of ['sendLeaseTx("renew", [rec.id], { gate })','sendLeaseTx("claim", [rec.id, _enclaveId], { gate })',
                 'sendLeaseTx("claim", [rec.id, _enclaveId], { gate: walletSendGate(w) })',
                 'sendLeaseTx("claim", [d.id, _enclaveId], { gate: walletSendGate(wallet) })'])
  assert.ok(source.includes(s),s);
 assert.equal((source.match(/sendLeaseTx\("(claim|renew)"/g)||[]).length,4,'no other claim/renew send');
 assert.equal((source.match(/hostWalletDecision\(/g)||[]).length,6,'definition + gate + renew + audit + held review + tryClaim');
 for(const pin of ['if (TERMINAL_STATUSES.has(r.status) && !r._stopPending) { r._gpu = null; saveStateSoon(); continue; }',
   'if (!(await stopContainer(rec))) return refuse("the running instance could not be verifiably stopped; the config change waits for it");',
   'await tearDown(rec, "expired"); // preserve confirmed-stop and lease-permit handling',
   'const stopConfirmed = await tearDown(rec, "terminated");','status: "terminated", instanceStopConfirmed: stopConfirmed,',
   'await settleStop(rec, true);   // the lease rule above is unchanged',
   'onSigned: (s) => (_onLeaseSigned ? _onLeaseSigned(s) : undefined)'])
  assert.ok(source.includes(pin),pin.slice(0,80));
 assert.equal((source.match(/\n\s*try \{ await stopContainer\(rec\); \} catch \{\}\n\s*if \(rec\._gpu\) \{ releaseGpu/g)||[]).length,0,'no teardown frees a slice after an unchecked stop');
 for(const pin of ['async function stopContainer(rec) {\n  // every teardown and relaunch comes here first: lease permissions and established streams end NOW, before any await\n  revokeLeasePermits(rec); cutDeploymentStreams(rec.id);',
   'revokeLeasePermits(rec);   // a (re)launch starts a new serving life',
   'settlePendingStops(instances);   // unconfirmed stops',
   'if (r._gpu && TERMINAL_STATUSES.has(r.status) && !r._stopPending) r._gpu = null;',
   'if (ex && ex._stopPending) return "its previous instance here is not confirmed stopped yet',
   'if (xr) trackDeploymentStream(xr.id, socket);'])
  assert.ok(source.includes(pin),pin.slice(0,80));
 const rec=source.slice(source.indexOf('async function reconcileInstances()'));
 assert.ok(rec.indexOf('settlePendingStops(instances)')<rec.indexOf('orphanInstancePlan('),'settled from the same listing, before reaping');
});
