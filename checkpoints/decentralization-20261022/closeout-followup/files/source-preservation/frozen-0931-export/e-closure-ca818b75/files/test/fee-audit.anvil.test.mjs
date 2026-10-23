// FEE AUDIT: what the app's EXISTING reserve can pay for a forced-inclusion lease, against what the L1 deposit costs.
//   L2: the PRODUCTION Base GasPriceOracle + L1Block (proxy and implementation code and the slots its upper-bound call
//       reads), captured from one public provider at one finalized block (evidence/capture/l2-gpo.json; research
//       provenance, not verification), behind the REAL EnclaveLeaseGasReserve at the calibrated l1Bps 10000.
//   L1: the PRODUCTION portal bytecode (test/support/l1-portal.mjs); L1 base fee 1 gwei, priority fee 0 (labelled).
// The proof is in receipts: the reserve's own LeaseGasPaid event and the payee's balance on L2, the L1 receipt's gas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as viem from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import * as F from '../src/forced-inclusion.mjs';
import * as P from '../src/lease-signing-policy.mjs';
import { startL1 } from './support/l1-portal.mjs';
import { startL2, setupLeaseWorld, forceInclude } from './support/l2-world.mjs';

const GPO = viem.getAddress('0x420000000000000000000000000000000000000F');
const CAP = JSON.parse(fs.readFileSync(new URL('../evidence/capture/l2-gpo.json', import.meta.url), 'utf8'));
const ORACLE = viem.parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)', 'function isIsthmus() view returns (bool)']);
const T = { timeout: 180000 };
let l1, l2, w, paid, l1Cost;
test.before(async () => {
  [l1, l2] = [await startL1(), await startL2()];
  await l2.loadCapture(CAP);
  w = await setupLeaseWorld(l2, { l1Oracle: GPO, l1Bps: 10000 });
});
test.after(() => { l1?.stop(); l2?.stop(); });

test('provenance: the replayed production GasPriceOracle answers getL1FeeUpperBound(460) exactly as the provider did', T, async () => {
  const captured = BigInt(CAP.extra[0].extra[0].result);
  assert.equal(await l2.read(GPO, ORACLE, 'getL1FeeUpperBound', [460n]), captured);
  assert.equal(await l2.read(GPO, ORACLE, 'isIsthmus'), true);
});

test('a forced-inclusion CLAIM: the reserve pays its payee ONLY the L1-fee upper bound (gas price 0); the L1 deposit costs orders of magnitude more', T, async (t) => {
  const c = await P.readSigningContext({ client: l2.pc, head: await l2.headNow(), pins: w.pins, id: w.id, kind: 1, enclaveId: w.enclaveId, operator: w.operator });
  const submitterKey = generatePrivateKey(), submitter = privateKeyToAccount(submitterKey).address;   // the L1 submitter's own address as payee
  const out = P.leaseSigningIntent({ route: 'l1-deposit', operation: 'claim', operator: w.operator, enclaveId: w.enclaveId, payee: submitter, context: c, pins: w.pins,
    forced: { optIn: true, operation: 'claim', inclusionWindowSec: 3600, portal: F.BASE_MAINNET.portal, maxChargeWei: 10n ** 15n } });
  const signature = await privateKeyToAccount(w.opKey).signTypedData(out.typedData);
  const snap = await F.readLeaseSnapshot({ client: l2.pc, head: c.head, pins: w.pins, operator: w.operator, id: w.id, kind: 1, enclaveId: w.enclaveId });
  const { plan } = await F.planLeaseDeposit({ pins: w.pins, operator: w.operator, lease: { ...out.want, payee: out.payee }, signature, snapshot: snap, l1Sender: submitter, l2GasLimit: 800_000n, now: c.head.timestamp + 5 });
  const payee0 = await l2.pc.getBalance({ address: submitter });
  const { receipt, l1: l1rc } = await forceInclude(F, l1, l2, plan, { key: submitterKey });
  assert.equal(receipt.status, 'success');
  const ev = receipt.logs.map((g) => { try { return viem.decodeEventLog({ abi: F.RESERVE_ABI, data: g.data, topics: g.topics }); } catch { return null; } }).find((e) => e?.eventName === 'LeaseGasPaid');
  paid = ev.args;
  // the executor flags the key's FIRST lease through it as carrying the 7702 authorization (105 more bytes), even
  // though a deposit can carry none: this first deposit lease is charged the authorization's bytes too
  const bound = await l2.read(GPO, ORACLE, 'getL1FeeUpperBound', [388n + 72n + 105n]);
  assert.equal(paid.gasPrice, 0n, 'deposit: tx.gasprice = 0, so the gas term is zero whatever the overheads');
  assert.equal(paid.l1FeeWei, bound, 'l1Bps 10000 x GasPriceOracle.getL1FeeUpperBound(388 + 72 + 105): the first-lease authorization surcharge');
  assert.equal(paid.chargedWei, bound);
  assert.equal(await l2.pc.getBalance({ address: submitter }) - payee0, bound, 'the payee received exactly that, from the app\'s reserve');
  l1Cost = l1rc.gasUsed * l1rc.effectiveGasPrice;
  // a second (renew) deposit lease is charged without the surcharge
  const after = await l2.read(GPO, ORACLE, 'getL1FeeUpperBound', [388n + 72n]);
  t.diagnostic(`FEE ${JSON.stringify({ reservePaidWei: bound.toString(), laterLeasesWei: after.toString(), l1GasUsed: l1rc.gasUsed.toString(), l1BaseFeeWei: l1rc.effectiveGasPrice.toString(), l1CostWei: l1Cost.toString(),
    coverage: Number(bound) / Number(l1Cost) })}`);
  assert.ok(bound * 1000n < l1Cost, 'the existing reserve formula covers far less than 0.1% of the L1 deposit cost');
});

test('every existing knob at its limit: the maximum the reserve can pay a deposit lease is still the L1 bound; the contracts refuse more', T, async () => {
  const q = (gasUsed, gasPrice, auth) => l2.read(w.addr.reserve, w.A.EnclaveLeaseGasReserve.abi, 'quote', [w.id, w.owner.address, 1, gasUsed, 388n, gasPrice, auth]);
  const [a] = await q(100_000n, 0n, false), [b] = await q(5_000_000n, 0n, false), [cAuth] = await q(100_000n, 0n, true);
  assert.equal(a, b, 'at gas price 0 the measured gas and the per-kind overheads (<= 80,000) do not matter');
  assert.equal(cAuth, await l2.read(GPO, ORACLE, 'getL1FeeUpperBound', [388n + 72n + 105n]), 'the authorization surcharge only adds bytes to the same bound (and cannot ride a deposit anyway)');
  // the admin's l1Bps is capped at 10000 by the contract
  const limits = { maxGasPriceCeiling: 10n ** 9n, overheadClaimGas: 80000, overheadRenewGas: 80000, overheadReleaseGas: 80000, minClaimInterval: 60, l1Bps: 10001 };
  const rc = await l2.write(l2.DEV, w.addr.reserve, w.A.EnclaveLeaseGasReserve.abi, 'setLimits', [limits], 0n, { allowRevert: true });
  assert.equal(rc.status, 'reverted', 'setLimits refuses l1Bps > 10000');
  // the ordinary relay path, for comparison, at a Base-like gas price (5e6 wei): the formula pays gas there
  const [relay] = await q(200_000n, 5_000_000n, false);
  assert.ok(relay > a);
  // the one EXISTING way the app's money can reach the L1 submitter: the owner's own reserve withdraw (manual, owner-
  // authorized, not per operation, not tied to any lease)
  const to = privateKeyToAccount(generatePrivateKey()).address;
  await l2.write(w.owner.key, w.addr.reserve, w.A.EnclaveLeaseGasReserve.abi, 'withdraw', [w.id, l1Cost, to]);
  assert.equal(await l2.pc.getBalance({ address: to }), l1Cost);
});
