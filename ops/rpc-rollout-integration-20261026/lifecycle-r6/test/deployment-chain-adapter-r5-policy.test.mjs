// r4 review corrections F1-F7 on the REAL candidate ledger + controller + identity (test/fixtures/r5-world.mjs; doubles labelled there).
// r5 deltas vs r4 (patches/r4-to-r5-tests.diff): authorityPins is the ACTUAL tuple getter (r4's indexed-array cases replaced), and the
// F2 test also checks the COMPOSED KVM host-admission-r1 consumer (lifecycleHostAdmitted) and a global catalog ban in anchor.enabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, keccak256, toBytes } from 'viem';
import { useAnvil, world, step, warp, mine, read, dep, tx, codeHash, S, HOST, LEDGER, LIFECYCLE, ZERO, PAID6 } from './fixtures/r5-world.mjs';
import { hostAdmissionPolicyHash } from '../network/host-admission-policy.mjs';
import { verifyGenerationChain } from '../network/deployment-generation-certificate.mjs';
import { lifecycleHostAdmitted } from '../network/deployment-authority-window.mjs';

useAnvil();
const MAX = Number.MAX_SAFE_INTEGER;
const sec = s => Math.floor(s.blockAt / 1000);
async function hostPolicy(w, p) {            // the host owner's committed policy: document by hash, commitment on the ownership contract
  const doc = { version: 1, chainId: 8453, ownershipContract: w.contracts.hostOwnership.toLowerCase(), hostId: HOST, requireCatalogApproval: false,
    denyDeployments: [], denyAppRefs: [], ...p };
  const h = hostAdmissionPolicyHash(doc); w.policyDocs.set(h, doc);
  await tx(w.admin, w.contracts.hostOwnership, S.K.TestHostOwnership.abi, 'set', [HOST, w.operator.address, 2n, h]); return h;
}

test('F2 anchor: global enabled/admitted and per-host hostAdmission are separate; the 34a3 verifier still accepts the anchor', async () => {
  const w = await world({ payout: 'owner' }); await step(w, 'queued', 'enroll');
  await tx(w.human, w.contracts.lifecycle, LIFECYCLE.abi, 'setAuthorityPolicy', [w.id, 60]); await mine();
  await hostPolicy(w, { denyDeployments: [w.id] });
  const now = () => Math.floor(Date.now() / 1000) + Math.floor(S.skewMs / 1000);
  const b = await S.pub.getBlock({ blockTag: 'latest' });                         // TEST DOUBLE recent head (labelled values)
  const head = { value: { proofVerified: true, tier: 'unsafe', number: Number(b.number), hash: b.hash, timestamp: Number(b.timestamp), observedAt: now(),
    anchorHash: b.hash, ancestryVerified: true, denied: false } };
  const generation = { head: { read: async () => ({ ...head.value }) }, certificates: { read: async () => [] } };
  const s = await w.adapter({ generation }).read(w.id), g = s.generationAuthority;
  assert.deepEqual([g.anchor.enabled, g.anchor.admitted, g.anchor.hostAdmission, s.admitted], [true, true, { host: HOST, admitted: false }, false]);
  const g2 = (await w.adapter({ generation }).read(w.id)).generationAuthority;
  Object.assign(g2.head, { anchorHash: g2.anchor.hash, number: g2.anchor.number, hash: g2.anchor.hash, timestamp: g2.anchor.timestamp });
  const ok = await verifyGenerationChain([], { ...g2, pins: { chainId: 8453, lifecycle: w.contracts.lifecycle }, nowSec: now() });
  assert.equal(ok.assignment.generation, 1);
  assert.equal(lifecycleHostAdmitted(g.anchor, HOST), false);                       // the COMPOSED KVM consumer reads the per-host field
  assert.throws(() => lifecycleHostAdmitted(g.anchor, `0x${'1'.repeat(64)}`), /missing/); // another candidate host is never admitted by it
  await tx(w.admin, w.contracts.catalog, S.K.TestCatalog.abi, 'set', [w.app({}), w.ver({ yanked: true })]);
  const y = (await w.adapter({ generation }).read(w.id)).generationAuthority.anchor;
  assert.deepEqual([y.enabled, y.admitted], [false, false]);                        // a global ban stays global for the composed runner
});

test('F1 self-hosted (payout = owner) and free owner (payout = owner\'s SessionVault): unfunded balance, rate 0 -> funded, admitted, unbounded; real start = uint64.max', async () => {
  for (const payout of ['owner', 'vault']) {
    const w = await world({ payout });
    assert.equal((await w.ledgerGet()).rate, 100n);                               // stored rate = the cap (the r2 adapter read this: unfunded)
    const s = await w.adapter().read(w.id);
    assert.deepEqual([s.funded, s.admitted, s.enabled, s.fundedUntil, s.host.rateWei], [true, true, true, MAX, '0'], payout);
    await step(w, 'queued', 'enroll'); await mine(); await step(w, 'running', 'ready'); await mine();
    const d = await w.ledgerGet(); assert.equal(d.leaseUntil, 2n ** 64n - 1n);
    const r = await w.adapter().read(w.id); assert.deepEqual([r.assignment.state, r.funded, r.fundedUntil], ['running', true, MAX], payout);
  }
});

test('F1 paid host: horizon = balance / rateFor(id, host), equal to the lease a real start buys; unaffordable here is host-only', async () => {
  const w = await world({ payout: 'other', fund6: 1000n });
  await step(w, 'queued', 'enroll'); await mine();
  const s = await w.adapter().read(w.id), bal = (await w.ledgerGet()).balance6;
  assert.equal(s.host.rateWei, PAID6.toString()); assert.equal(s.fundedUntil - sec(s), Number(bal / PAID6));
  await step(w, 'running', 'ready');
  const start = await S.pub.getBlock({ blockTag: 'latest' }), d = await w.ledgerGet();
  assert.equal(Number(d.leaseUntil) - Number(start.timestamp), s.fundedUntil - sec(s));                // no grant beyond the actual lease
  const r = await w.adapter().read(w.id); assert.deepEqual([r.funded, r.fundedUntil], [true, Number(d.leaseUntil)]);
  const u = await world({ payout: 'other' });                                     // paid host, nothing funded: no start here, no global stop
  const q = await u.adapter().read(u.id);
  assert.deepEqual([q.admitted, q.funded, q.enabled, q.fundedUntil], [false, true, true, sec(q)]);
});

test('F1 stale stored rate: a free run ended, host turns paid -> horizon is the paid one (not unbounded); revoked self-hosting while running -> unfunded now', async () => {
  const w = await world({ payout: 'owner', fund6: 1000n });
  await step(w, 'queued', 'enroll'); await mine(); await step(w, 'running', 'ready'); await mine();
  await step(w, 'queued', 'owner requeue'); await mine();
  assert.equal((await w.ledgerGet()).rate, 0n);                                  // lifecycleEnd keeps the previous lease's rate
  await w.setPayout('other');
  const s = await w.adapter().read(w.id), bal = (await w.ledgerGet()).balance6;
  assert.equal(s.fundedUntil - sec(s), Number(bal / PAID6)); assert.notEqual(s.fundedUntil, MAX);
  await warp(30); await step(w, 'running', 'ready');
  const start = await S.pub.getBlock({ blockTag: 'latest' }), d = await w.ledgerGet();
  assert.equal(Number(d.leaseUntil) - Number(start.timestamp), Number(bal / PAID6));
  const v = await world({ payout: 'owner' });
  await step(v, 'queued', 'enroll'); await mine(); await step(v, 'running', 'ready'); await mine();
  await v.setPayout('other');                                                     // self-hosting revoked: ledger lifecycleFunded false
  const r = await v.adapter().read(v.id); assert.deepEqual([r.funded, r.fundedUntil], [false, sec(r)]);
});

test('F3/F4 production catalog policy (private pending allowed, public pending / rejected refused) and canonical appRef', async () => {
  const cases = [[{ approval: 0, isPublic: false }, true], [{ approval: 0, isPublic: true }, false], [{ approval: 2, isPublic: false }, false], [{ approval: 1, isPublic: true }, true]];
  for (const [o, want] of cases) {
    const w = await world({ payout: 'owner', ...o }), s = await w.adapter().read(w.id);
    assert.equal(s.enabled, want, JSON.stringify(o)); assert.equal(s.admitted, want, JSON.stringify(o));    // production host admission also applies platform policy
    assert.equal(s.catalog.refusal === null, want);
  }
  const z = await world({ payout: 'owner', appVersion: '007' }), s = await z.adapter().read(z.id);
  assert.equal(s.appRef, `catalog://${z.appId}/7`); assert.equal(s.enabled, true);
});

test('F3 host-owner policy (committed on the ownership contract, read at the same block) denies only THIS host', async () => {
  const w = await world({ payout: 'owner', appVersion: '007' }), r = () => w.adapter().read(w.id);
  await hostPolicy(w, { denyDeployments: [w.id] });
  let s = await r(); assert.deepEqual([s.enabled, s.admitted, s.funded], [true, false, true]); assert.match(s.host.ownerDenial, /declines/);
  await hostPolicy(w, { denyAppRefs: [`catalog://${w.appId}/7`] });               // canonical ref matches the leading-zero ledger ref
  s = await r(); assert.equal(s.admitted, false); assert.match(s.host.ownerDenial, /declines/);
  const p = await world({ payout: 'owner', approval: 0 });
  await hostPolicy(p, { requireCatalogApproval: true });
  s = await p.adapter().read(p.id); assert.deepEqual([s.enabled, s.admitted], [true, false]);
  const h = await hostPolicy(w, {}); w.policyDocs.delete(h);                      // committed document unavailable: fail closed for starts only
  s = await r(); assert.deepEqual([s.enabled, s.admitted], [true, false]); assert.match(s.host.ownerDenial, /unavailable/);
  await hostPolicy(w, {}); w.policyDocs.set(h, { ...w.policyDocs.get(h), denyDeployments: [w.id] });          // swapped document: hash no longer matches
  s = await r(); assert.equal(s.admitted, false);
  await tx(w.admin, w.contracts.hostOwnership, S.K.TestHostOwnership.abi, 'set', [HOST, ZERO, 3n, `0x${'0'.repeat(64)}`]);
  s = await r(); assert.deepEqual([s.enabled, s.admitted], [true, false]);       // no host owner: never admitted here
});

test('F5 administrator change: explicit deny of new starts; reads, queue and stop (withdrawal) continue; allowed sets are explicit', async () => {
  const w = await world({ payout: 'owner' });
  await tx(w.admin, w.contracts.ledger, LEDGER.abi, 'setOwner', [w.other.address]);                // two-step handoff begins
  const a = w.adapter(); let s = await a.read(w.id);
  assert.deepEqual([s.adminChanged, s.adminChanges, s.enabled, s.admitted, s.funded], [true, ['ledger.pendingOwner'], true, false, true]);
  await step(w, 'queued', 'enroll'); await mine();
  s = await a.read(w.id); assert.equal(s.assignment.state, 'queued');
  await assert.rejects(a.prepare(w.id, s, 'running', 'ready'), /new starts denied/);
  const pins = { ...w.pins, admins: { ...w.pins.admins, ledgerPendingOwner: [ZERO, w.other.address] } };
  assert.deepEqual([(await w.adapter({ pins }).read(w.id)).adminChanged, (await w.adapter({ pins }).read(w.id)).admitted], [false, true]);
  const stop = await a.prepare(w.id, s, 'stopped', 'owner stop'); await a.submit(w.id, stop); await mine();
  const r = await a.resolve(w.id, stop); assert.deepEqual([r.outcome, r.verified], ['confirmed', true]);
  await tx(w.admin, w.contracts.addressBook, S.K.TestAddressBook.abi, 'setPendingOwner', [w.other.address]);
  assert.ok((await a.read(w.id)).adminChanges.includes('addressBook.pendingOwner'));
  const bad = { ...w.pins, contracts: { ...w.pins.contracts, catalog: { ...w.pins.contracts.catalog, codeHash: keccak256(toBytes('x')) } } };
  await assert.rejects(w.adapter({ pins: bad }).read(w.id), /not the pinned code hash/);           // code/schema/bindings stay fail-closed
});

test('F6 recursive closure: every reviewed getter, exact indexed lengths, nested legacy pins preserved, the five primary bindings name THIS ledger', async () => {
  const w = await world({ payout: 'owner' }); await w.adapter().read(w.id);
  const C = w.pins.contracts, P = c => ({ ...w.pins, contracts: { ...C, ...c } });
  const withB = (k, b) => ({ [k]: { ...C[k], bindings: b } });
  assert.throws(() => w.adapter({ pins: P(withB('pinnedSessionAuthority', { ...C.pinnedSessionAuthority.bindings, deployments: 'legacyLedger' })) }), /must be THIS ledger/);
  const { router, ...noRouter } = C.sessionVaultImplementation.bindings;
  assert.throws(() => w.adapter({ pins: P(withB('sessionVaultImplementation', noRouter)) }), /sessionVaultImplementation\.router is not reviewed/);
  const { 'authorityPins.authority': _, ...two } = C.sessionVaultFactory.bindings;   // every named output of the tuple getter is reviewed
  assert.throws(() => w.adapter({ pins: P(withB('sessionVaultFactory', two)) }), /sessionVaultFactory\.authorityPins\.authority is not reviewed/);
  assert.throws(() => w.adapter({ pins: P(withB('sessionVaultFactory', { ...two, 'authorityPins[0]': 'legacyLedger', 'authorityPins.authority': 'pinnedSessionAuthority' })) }),
    /authorityPins\[0\] is not an address getter/);                              // r4's indexed-array model is not the actual ABI
  await assert.rejects(w.adapter({ pins: P(withB('sessionVaultFactory', { ...C.sessionVaultFactory.bindings, 'authorityPins.ledger': 'ledger' })) }).read(w.id),
    /binding sessionVaultFactory\.authorityPins\.ledger differs/);                // the old factory's legacy pin is verified, never rewritten
  const stale = await dep(w.admin, 'R4Connectivity', [w.contracts.legacyLedger, w.contracts.registry]);
  const p1 = P({ connectivity: { ...C.connectivity, address: stale, codeHash: await codeHash(stale) } });
  p1.addressBook = { ...p1.addressBook }; // book still names the reviewed connectivity -> F7 refuses before any read
  assert.throws(() => w.adapter({ pins: p1 }), /address book entry for connectivity differs/);
  const sv = await dep(w.admin, 'R4SecretVaultV2', [w.contracts.connectivity, w.contracts.ledger, w.ext.enclaveOwner, w.contracts.hostOwnership, w.contracts.registry, w.contracts.sessionVaultFactory]);
  const book2 = { ...w.pins.addressBook, [keccak256(toBytes('secretVaultV2'))]: sv };
  const p2 = { ...P({ secretVaultV2: { ...C.secretVaultV2, address: sv, codeHash: await codeHash(sv) } }), addressBook: book2 };
  await assert.rejects(w.adapter({ pins: p2 }).read(w.id), /address book differs|binding secretVaultV2\.book differs/);
  assert.throws(() => w.adapter({ pins: { ...w.pins, preservedFactories: ['catalog'] } }), /preserved factory catalog/);
  assert.throws(() => w.adapter({ pins: { ...w.pins, preservedFactories: [] } }), /preservedFactories/);
  assert.throws(() => w.adapter({ pins: { ...w.pins, identityFactories: [{ factory: w.contracts.catalog, codeHash: C.catalog.codeHash }] } }), /not a reviewed sessionVaultFactory/);
  assert.throws(() => w.adapter({ pins: P(withB('connectivity', { ledger: 'ledger', registry: 'notPinned' })) }), /not a code-pinned contract/);
});

test('F7 the address book and the contract pins are one reviewed source', async () => {
  const w = await world({ payout: 'owner' });
  assert.throws(() => w.adapter({ pins: { ...w.pins, bookKeys: { ...w.pins.bookKeys, catalog: keccak256(toBytes('registry')) } } }), /entry for catalog differs/);
  const extra = keccak256(toBytes('unreviewed'));
  assert.throws(() => w.adapter({ pins: { ...w.pins, addressBook: { ...w.pins.addressBook, [extra]: w.admin.address } } }), /not mapped to a reviewed pin/);
  assert.equal(getAddress((await w.adapter().read(w.id)).host.operator), w.operator.address);
});
