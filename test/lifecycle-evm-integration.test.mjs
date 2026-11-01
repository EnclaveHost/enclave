// Maintained adapter on actual reviewed contract bytes in isolated loopback Anvil.
// Finality is deliberately a test capability; this does not authenticate Base.
// Pending-intent restart uses the maintained kernel-owned durable journal.
// TEST doubles: finality authority, manager, remote enforcement and ephemeral signers.
// Residual race (documented, not tested as solved): the chain can still change after the final qualified read and before mining; the
// Solidity transition ABI/digest is unchanged and does not bind the host authority on chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useAnvil, mine, warp, HOST, chainNow, send, tx, step, ZERO32, testAuthority } from './fixtures/lifecycle-evm-base.mjs';
import { worldHR, RA, ownerOffline, quorumOffline, recoverHost } from './fixtures/lifecycle-registry-evm.mjs';
import { createLifecycleChainAdapter } from '../network/deployment-chain-adapter.mjs';
import { ownLifecycleJournal } from '../network/deployment-journal-owner.mjs';
import { evmOwnedDispatch } from './helpers/evm-owned-dispatch.mjs';
useAnvil();

function adapterWith(w, hooks = {}) {
  const spy = { sends: 0 };
  const base = testAuthority(w.auth, 'derived');
  const a = createLifecycleChainAdapter({ pins: w.pins, authority: { ...base, snapshot: async fn => ({ ...await base.snapshot(fn), observedAt: chainNow() }) },
    receipts: w.receipts, hostPolicy: { load: async () => { throw Error('TEST: no committed host policy document'); } }, generation: null, now: chainNow,
    actorSigner: async ({ target, typedData }) => { const acct = target === 'running' ? w.operator : w.human;
      const signature = await acct.signTypedData(typedData); await hooks.afterActor?.(); return { address: acct.address, signature }; },
    approvals: async ({ typedData }) => { const s = await Promise.all(w.witnesses.map(x => x.signTypedData(typedData))); await hooks.afterApprovals?.(); return s; },
    relay: { address: w.relay.address, send: async t => { spy.sends++;
      await send(w.relay, { to: t.to, data: t.data, maxFeePerGas: t.maxFeePerGasWei, maxPriorityFeePerGas: 1n });
      if (hooks.lose) throw Error('response lost'); } } });
  return { a, spy };
}
async function prepared(t, hooks) {
  const w = await worldHR(); await step(w, 'queued', 'TEST queue'); await mine();
  const { a, spy } = adapterWith(w, hooks);
  const s = await a.read(w.id), intent = await a.prepare(w.id, s, 'running', 'TEST start');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evm-adapter-')), file=path.join(dir,'j.json');
  const owner=await ownLifecycleJournal(file,{initialize:true}), journal=owner.journal;
  const result={w,a,spy,s,intent,journal,owner,file};
  t.after(async()=>{await result.owner.close();fs.rmSync(dir,{recursive:true,force:true});});
  journal.prepareTransition(w.id,intent);
  return result;
}
const ctxOf = intent => JSON.parse(intent.payload).hostAuthority;

test('5a prepare persists the exact versioned host authority IN the durable canonical payload', async t => {
  const { s, intent, journal, w } = await prepared(t);
  const h = ctxOf(intent);
  assert.equal(h.context.hostGeneration, '1'); assert.equal(h.context.digest, s.hostAuthorityEvidence.context.digest);
  assert.equal(h.provenance.intentDigest, intent.digest); assert.equal(journal.read(w.id).pending.payload, intent.payload);
  assert.equal(s.hostLifecycle.verified, undefined); assert.equal(s.hostAuthorityEvidence.proofVerified, true);
});
test('5b Offline during the delayed actorSigner: refused before relay.send; durable intent unchanged', async t => {
  let w0; const r = await prepared(t, { afterActor: async () => { await ownerOffline(w0); await mine(); } }); w0 = r.w;
  await assert.rejects(r.a.submit(r.w.id, r.intent), /final send guard: canonical host is offline/);
  assert.equal(r.spy.sends, 0); assert.equal(r.journal.read(r.w.id).pending.payload, r.intent.payload);
});
test('5c owner policy/revision change during delayed approvals: refused before relay.send', async t => {
  let w0; const r = await prepared(t, { afterApprovals: async () => {
    await tx(w0.hostOwner, w0.contracts.registry, RA, 'setHostPolicy', [HOST, w0.policy(w0.reporters2), ZERO32]); await mine(); } }); w0 = r.w;
  await assert.rejects(r.a.submit(r.w.id, r.intent), /host authority changed since preparation/);
  assert.equal(r.spy.sends, 0);
});
test('5d unqualified authority after signatures refuses; stable authority sends exactly once', async t => {
  let w0; const r = await prepared(t, { afterActor: async () => { w0.auth.proof = false; } }); w0 = r.w;
  await assert.rejects(r.a.submit(r.w.id, r.intent), /no proof-qualified/); assert.equal(r.spy.sends, 0);
  r.w.auth.proof = true;
  const ok = adapterWith(r.w);
  await ok.a.submit(r.w.id, r.intent); assert.equal(ok.spy.sends, 1);
  await mine(); assert.equal((await ok.a.resolve(r.w.id, r.intent)).outcome, 'confirmed');
});
test('6 mined lost reply, then missed Offline + recovery + restart: exact pending resolves once from the receipt, no resend', async t => {
  const r = await prepared(t, { lose: true });
  await assert.rejects(r.a.submit(r.w.id, r.intent), /response lost/); assert.equal(r.spy.sends, 1);
  await mine(); await quorumOffline(r.w); await recoverHost(r.w); await mine();
  await r.owner.close();
  r.owner=await ownLifecycleJournal(r.file);r.journal=r.owner.journal;
  const restarted = adapterWith(r.w), res = await restarted.a.resolve(r.w.id, r.journal.read(r.w.id).pending);
  assert.equal(res.outcome, 'confirmed'); assert.equal(res.verified, true); assert.equal(restarted.spy.sends, 0);
  const now = await restarted.a.read(r.w.id);
  assert.equal(now.hostAuthorityEvidence.context.hostGeneration, '2');
  assert.notEqual(now.hostAuthorityEvidence.context.digest, ctxOf(r.intent).context.digest, 'the old-context start does not carry current authority');
});
test('6b current Offline with expired historical qualification: Running refused, owner stop still prepared/sent', async t => {
  const w = await worldHR(); await step(w, 'queued', 'TEST queue'); await warp(7200); await ownerOffline(w); await mine();
  const { a, spy } = adapterWith(w), s = await a.read(w.id);
  assert.equal(s.hostAuthorityEvidence.status, 'offline');
  await assert.rejects(a.prepare(w.id, s, 'running', 'TEST'), /offline|Online|not the current/);
  const stop = await a.prepare(w.id, s, 'stopped', 'TEST owner stop'); assert.equal(JSON.parse(stop.payload).hostAuthority, undefined);
  await a.submit(w.id, stop); assert.equal(spy.sends, 1);
});
test('6c a Running payload without host authority (legacy/lost context) is resolvable but never sent', async t => {
  const r = await prepared(t);
  const p = JSON.parse(r.intent.payload); delete p.hostAuthority;
  const legacy = { digest: r.intent.digest, payload: JSON.stringify(p) };
  await assert.rejects(r.a.submit(r.w.id, legacy), /without the exact host authority/); assert.equal(r.spy.sends, 0);
  assert.ok(['unknown', 'finalized-fence'].includes((await r.a.resolve(r.w.id, legacy)).outcome));
  await assert.rejects(r.a.submit(r.w.id, { ...r.intent, payload: r.intent.payload.replace('"hostGeneration":"1"', '"hostGeneration":"2"') }), /canonical|digest/);
});

test('actual chain drives owned runtime and permits under foreign platform refusal; owner Offline withdraws locally',async t=>{
 const w=await worldHR();assert.deepEqual(w.zeroEth.before,{operator:0n,owner:0n});assert.deepEqual(w.zeroEth.after,w.zeroEth.before);
 await step(w,'queued','TEST queue');await mine();const f=await evmOwnedDispatch(t,w);
 await f.service.dispatch.activate();
 const first=await f.service.dispatch.reconcile(w.id);assert.equal(first.status,'pending',JSON.stringify(first));
 assert.equal(f.allowed,false);assert.equal(f.spawns,1);
 await mine();const settled=await f.service.dispatch.reconcile(w.id);assert.equal(settled.status,'reconcile',JSON.stringify(settled));
 const serving=await f.service.dispatch.reconcile(w.id);assert.equal(serving.status,'running',JSON.stringify(serving));
 assert.equal(f.allowed,true);assert.equal(f.platformCalls,0);assert.equal(f.spawns,1);
 await ownerOffline(w);await mine();const offline=await f.service.dispatch.reconcile(w.id);
 assert.notEqual(offline.status,'running');assert.equal(f.allowed,false);assert.equal(f.vm,null);
});
