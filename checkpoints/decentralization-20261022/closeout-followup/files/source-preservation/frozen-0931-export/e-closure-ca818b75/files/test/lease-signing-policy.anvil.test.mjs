// The opt-in forced-inclusion signing policy against the REAL lease contracts (test/support/l2-world.mjs: live ledger
// rev 16d, registry, reserve, executor) with the PRODUCTION renewWindow of 300 s: the relay route is unchanged; the
// forced route is explicit, bounded and refuses what the owner's configuration cannot support; its output signs (TEST
// key) into exactly what planLeaseDeposit accepts and the real portal + executor execute.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as viem from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as F from '../src/forced-inclusion.mjs';
import * as P from '../src/lease-signing-policy.mjs';
import { startL1 } from './support/l1-portal.mjs';
import { startL2, setupLeaseWorld, forceInclude } from './support/l2-world.mjs';

const T = { timeout: 180000 };
let l1, l2, w;
test.before(async () => { [l1, l2] = [await startL1(), await startL2()]; w = await setupLeaseWorld(l2); });
test.after(() => { l1?.stop(); l2?.stop(); });
const ctx = async (kind) => P.readSigningContext({ client: l2.pc, head: await l2.headNow(), pins: w.pins, id: w.id, kind, enclaveId: kind === 1 ? w.enclaveId : '0x' + '00'.repeat(32), operator: w.operator });
const forced = (operation, o = {}) => ({ optIn: true, operation, inclusionWindowSec: 3600, portal: F.BASE_MAINNET.portal, maxChargeWei: 10n ** 14n, ...o });

test('relay route is today\'s: deadline head + 300 s; forced options without the forced route are refused', T, async () => {
  const c = await ctx(1);
  const out = P.leaseSigningIntent({ operation: 'claim', operator: w.operator, enclaveId: w.enclaveId, payee: w.operator, maxChargeWei: 10n ** 14n, context: c, pins: w.pins });
  assert.equal(out.want.deadline, BigInt(c.head.timestamp + 300));
  assert.deepEqual(Object.keys(out.want), ['id', 'kind', 'enclaveId', 'nonce', 'deadline', 'maxChargeWei'], 'the executor client\'s request shape');
  assert.throws(() => P.leaseSigningIntent({ operation: 'claim', operator: w.operator, enclaveId: w.enclaveId, payee: w.operator, maxChargeWei: 1n, context: c, pins: w.pins, forced: forced('claim') }),
    (e) => e.code === 'forced-options-without-forced-route');
});

test('forced CLAIM: explicit, bounded, within the owner budget; signed (TEST key) it is exactly what the planner accepts and the real portal + executor run', T, async (t) => {
  const c = await ctx(1);
  const base = { route: 'l1-deposit', operation: 'claim', operator: w.operator, enclaveId: w.enclaveId, payee: privateKeyToAccount(w.relayer).address, context: c, pins: w.pins };
  assert.throws(() => P.leaseSigningIntent({ ...base }), (e) => e.code === 'not-opted-in');
  assert.throws(() => P.leaseSigningIntent({ ...base, forced: forced('renew') }), (e) => e.code === 'operation-mismatch');
  assert.throws(() => P.leaseSigningIntent({ ...base, forced: forced('claim', { portal: w.addr.ledger }) }), (e) => e.code === 'route-mismatch');
  assert.throws(() => P.leaseSigningIntent({ ...base, forced: forced('claim', { inclusionWindowSec: 7 * 86400 }) }), (e) => e.code === 'inclusion-window-out-of-range');
  assert.throws(() => P.leaseSigningIntent({ ...base, forced: forced('claim', { maxChargeWei: 10n ** 16n }) }), (e) => e.code === 'over-owner-budget');
  const out = P.leaseSigningIntent({ ...base, forced: forced('claim') });
  assert.equal(out.want.deadline, BigInt(c.head.timestamp + 3600));
  assert.equal(out.continuity.guaranteed, false);
  t.diagnostic(`continuity: ${out.continuity.reason}`);
  assert.ok(out.continuity.protocolMaxInclusionSec > Number(c.leaseSec), `protocol worst case ${out.continuity.protocolMaxInclusionSec} s > ledger lease ${c.leaseSec} s`);
  const signature = await privateKeyToAccount(w.opKey).signTypedData(out.typedData);
  const snap = await F.readLeaseSnapshot({ client: l2.pc, head: c.head, pins: w.pins, operator: w.operator, id: w.id, kind: 1, enclaveId: w.enclaveId });
  const { plan } = await F.planLeaseDeposit({ pins: w.pins, operator: w.operator, lease: { ...out.want, payee: out.payee }, signature, snapshot: snap,
    l1Sender: privateKeyToAccount(w.relayer).address, l2GasLimit: 800_000n, now: c.head.timestamp + 5 });
  const { receipt } = await forceInclude(F, l1, l2, plan, { key: w.relayer });
  assert.equal(receipt.status, 'success');
  assert.equal((await l2.read(w.addr.ledger, w.A.EnclaveDeployments.abi, 'get', [w.id])).runnerOperator, viem.getAddress(w.operator));
});

test('forced RENEW against the production renewWindow (300 s) is REFUSED, not reconfigured; release only where sponsored; a second open authorization is refused', T, async () => {
  const row = await l2.read(w.addr.ledger, w.A.EnclaveDeployments.abi, 'get', [w.id]);
  await l2.warp(row.leaseUntil - 200n);
  const c = await ctx(2);
  assert.equal(c.reserve.renewWindow, 300);
  const base = { route: 'l1-deposit', operation: 'renew', operator: w.operator, payee: w.operator, context: c, pins: w.pins };
  assert.throws(() => P.leaseSigningIntent({ ...base, forced: forced('renew', { inclusionWindowSec: 900 }) }), (e) => e.code === 'renew-window-too-short');
  const r0 = await l2.read(w.addr.reserve, P.RESERVE_POLICY_ABI, 'reserveOf', [w.id, w.owner.address]);
  assert.equal(r0.renewWindow, 300, 'the owner\'s configuration is untouched');
  // with a policy floor below 300 the window still cannot exceed the lease left (200 s)
  assert.throws(() => P.leaseSigningIntent({ ...base, forced: forced('renew', { inclusionWindowSec: 250 }), policy: { minInclusionSec: 60 } }), (e) => e.code === 'lease-ends-before-inclusion');
  // release: the owner sponsors it here
  const cr = await ctx(3);
  const rel = P.leaseSigningIntent({ ...base, operation: 'release', context: cr, forced: forced('release') });
  assert.equal(rel.want.kind, 3);
  // an unresolved earlier forced authorization for this deployment blocks a second one
  const tr = new F.ForcedInclusionTracker();
  tr.admit(`lease:8453:${w.operator.toLowerCase()}:${w.id.toLowerCase()}`, '0x01', {});
  assert.throws(() => P.leaseSigningIntent({ ...base, operation: 'release', context: cr, forced: forced('release'), tracker: tr }), (e) => e.code === 'ambiguous-duplicate');
});
