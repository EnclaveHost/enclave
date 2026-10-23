// The PRODUCTION Base OptimismPortal bytecode (captured, see test/support/l1-portal.mjs) executed on a local L1:
// what an UNSIGNED plan's L1 transaction actually does once signed (by a TEST key, on the local chain only).
//   - provenance: the replayed code answers version() and params() exactly as the provider did at the block;
//   - the plan's transaction from an EOA, from a contract wallet, from a 7702-delegated EOA via a relayer: the real
//     TransactionDeposited `from` (as-is or aliased), decoded and matched by the module, the derived 0x7E hash;
//   - L1 gas: execution plus the resource-metering burn, at several L1 base fees, as receipts measure it;
//   - refusals: gas below the portal floor (reverts on L1, frees the slot only with that receipt), wrong portal /
//     implementation / version pins, a log from another address.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as viem from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { extractTransactionDepositedLogs, getL2TransactionHash } from 'viem/op-stack';
import * as F from '../src/forced-inclusion.mjs';
import { CAPTURE, startL1, readPortal } from './support/l1-portal.mjs';

const PORTAL = F.BASE_MAINNET.portal;
const IMPL = viem.getAddress(viem.slice(CAPTURE.accounts[PORTAL.toLowerCase()].storage[F.EIP1967_IMPLEMENTATION_SLOT], 12));
const PIN = { portal: PORTAL, implementation: IMPL, versions: ['6.0.1'] };
const T = { timeout: 120000 };
const TEST_L1 = { verifiers: ['test-anvil-l1'] };   // LABEL: the local anvil L1, never an L1 light client
const proofOf = (rc) => ({ verifiedBy: 'test-anvil-l1', headerHash: rc.blockHash });
const plan = (to, data, gasLimit = 800_000n, from) => ({
  operation: 'lease.claim', l1Transaction: { chainId: 1, to: PORTAL, value: 0n, data: viem.encodeFunctionData({ abi: F.PORTAL_ABI, functionName: 'depositTransaction', args: [to, 0n, gasLimit, false, data] }) },
  deposit: { to, value: 0n, mint: 0n, gasLimit, isCreation: false, data, acceptableFrom: [from, F.applyL1ToL2Alias(from)] } });
const LEASE_DATA = viem.concat(['0x7c1e3c86', '0x' + 'cd'.repeat(384)]);   // 388 bytes, the executor's canonical size

let l1;
test.before(async () => { l1 = await startL1(); });
test.after(() => l1?.stop());

test('provenance: the replayed production portal answers version() and params() as the provider did at the captured block', T, async () => {
  const [ver, , params] = CAPTURE.extra[0].extra.map((x) => x.result);
  const v = await l1.pc.readContract({ address: PORTAL, abi: viem.parseAbi(['function version() view returns (string)']), functionName: 'version' });
  assert.equal(v, viem.decodeAbiParameters([{ type: 'string' }], ver)[0]);
  assert.equal(v, '6.0.1');
  const p = await l1.pc.call({ to: PORTAL, data: viem.toFunctionSelector('params()') });
  assert.equal(p.data, params);
  assert.equal(viem.keccak256(await l1.pc.getCode({ address: IMPL })), CAPTURE.accounts[IMPL.toLowerCase()].codeHash);
  F.checkPortalPin(await readPortal(l1, PORTAL), PIN, TEST_L1);
});

test('the plan\'s L1 transaction from an EOA: one real TransactionDeposited from the EOA itself; the module derives its 0x7E hash', T, async (t) => {
  const key = generatePrivateKey(), from = privateKeyToAccount(key).address;
  const to = viem.getAddress('0x' + '22'.repeat(20));
  const pl = plan(to, LEASE_DATA, 800_000n, from);
  const rc = await l1.send(key, pl.l1Transaction);
  assert.equal(rc.status, 'success');
  const m = F.matchDepositEvent(pl, rc, proofOf(rc), TEST_L1);
  assert.equal(m.from, from, 'an EOA is not aliased');
  const [log] = extractTransactionDepositedLogs({ logs: rc.logs });
  assert.equal(m.l2TransactionHash, getL2TransactionHash({ log }));
  t.diagnostic(`EOA deposit: L1 gasUsed ${rc.gasUsed} at base fee 1 gwei`);
});

test('a contract wallet is ALIASED; a 7702-delegated EOA called by a relayer is NOT (portal 6.0.1 behaviour, measured)', T, async (t) => {
  const wallet = viem.getAddress('0x' + '5a'.repeat(20));
  await l1.makeContract(wallet, PORTAL);
  const relayer = generatePrivateKey();
  const to = viem.getAddress('0x' + '33'.repeat(20));
  const pl = plan(to, LEASE_DATA, 800_000n, wallet);
  const rc = await l1.send(relayer, { to: wallet, data: pl.l1Transaction.data });
  assert.equal(rc.status, 'success');
  const m = F.matchDepositEvent(pl, rc, proofOf(rc), TEST_L1);
  assert.equal(m.from, F.applyL1ToL2Alias(wallet), 'contract sender aliased');
  // an EOA delegated (7702) to the same forwarder code, called by a relayer: msg.sender != tx.origin
  const eoaKey = generatePrivateKey(), eoa = privateKeyToAccount(eoaKey).address;
  await l1.fund(privateKeyToAccount(relayer).address);
  const fwd = viem.getAddress('0x' + '6b'.repeat(20));
  await l1.makeContract(fwd, PORTAL);
  const auth = await l1.wallet(eoaKey).signAuthorization({ account: privateKeyToAccount(eoaKey), contractAddress: fwd });
  const pl2 = plan(to, LEASE_DATA, 800_000n, eoa);
  const h = await l1.wallet(relayer).sendTransaction({ to: eoa, data: pl2.l1Transaction.data, authorizationList: [auth], gas: 2_000_000n });
  const rc2 = await l1.pc.waitForTransactionReceipt({ hash: h });
  assert.equal(rc2.status, 'success');
  const [log] = extractTransactionDepositedLogs({ logs: rc2.logs });
  t.diagnostic(`7702-delegated EOA via relayer: deposit from ${log.args.from} (EOA ${eoa}, alias ${F.applyL1ToL2Alias(eoa)})`);
  assert.equal(viem.getAddress(log.args.from), eoa, 'portal 6.0.1 treats a 7702-delegated EOA as an EOA');
});

test('L1 cost: execution gas plus the resource-metering burn, measured at several L1 base fees', T, async (t) => {
  const rows = [];
  for (const gwei of [0.1, 1, 5, 30]) {
    const l = await startL1({ baseFeeWei: BigInt(Math.round(gwei * 1e9)) });
    try {
      for (const gasLimit of [400_000n, 800_000n]) {
        const key = generatePrivateKey();
        const pl = plan(viem.getAddress('0x' + '44'.repeat(20)), LEASE_DATA, gasLimit, privateKeyToAccount(key).address);
        const rc = await l.send(key, pl.l1Transaction, { gas: 3_000_000n });
        assert.equal(rc.status, 'success');
        rows.push({ baseFeeGwei: gwei, l2GasLimit: Number(gasLimit), l1GasUsed: Number(rc.gasUsed), effectiveGasPrice: rc.effectiveGasPrice.toString(), l1CostWei: (rc.gasUsed * rc.effectiveGasPrice).toString() });
      }
    } finally { l.stop(); }
  }
  t.diagnostic('L1_COST ' + JSON.stringify(rows));
  // the burn: below 1 gwei the portal divides by 1 gwei, so gas grows; above, gas falls toward the execution cost
  const at = (g, lim) => rows.find((r) => r.baseFeeGwei === g && r.l2GasLimit === lim);
  assert.ok(at(0.1, 800_000).l1GasUsed > at(30, 800_000).l1GasUsed);
  assert.ok(at(1, 800_000).l1GasUsed > at(1, 400_000).l1GasUsed, 'a bigger L2 gas limit burns more L1 gas');
});

test('refusals: gas below the portal floor reverts on L1 (no deposit; the slot frees only with that receipt); wrong pins; a look-alike log', T, async () => {
  const key = generatePrivateKey(), from = privateKeyToAccount(key).address;
  const pl = plan(viem.getAddress('0x' + '55'.repeat(20)), LEASE_DATA, 30_000n, from);   // floor = 21000 + 40 * 388 = 36520
  const rc = await l1.send(key, pl.l1Transaction);
  assert.equal(rc.status, 'reverted');
  assert.equal(extractTransactionDepositedLogs({ logs: rc.logs }).length, 0);
  assert.throws(() => F.matchDepositEvent(pl, rc, proofOf(rc), TEST_L1), (e) => e.code === 'l1-transaction-failed');
  const tr = new F.ForcedInclusionTracker();
  tr.admit('k', '0x01', {});
  tr.checkL1Send('k', (await l1.pc.getTransaction({ hash: rc.transactionHash })).nonce);
  tr.resolveFailedL1('k', { ...rc, nonce: (await l1.pc.getTransaction({ hash: rc.transactionHash })).nonce }, proofOf(rc), TEST_L1);
  assert.equal(tr.get('k').state, 'dead');
  // pins: another implementation, another version, another portal, an unlabelled read
  const snap = await readPortal(l1, PORTAL);
  assert.throws(() => F.checkPortalPin({ ...snap, implementation: viem.getAddress('0x' + '01'.repeat(20)) }, PIN, TEST_L1), (e) => e.code === 'portal-pin-mismatch');
  assert.throws(() => F.checkPortalPin({ ...snap, version: '7.0.0' }, PIN, TEST_L1), (e) => e.code === 'portal-version-unreviewed');
  assert.throws(() => F.checkPortalPin({ ...snap, portal: viem.getAddress('0x' + '02'.repeat(20)) }, PIN, TEST_L1), (e) => e.code === 'portal-pin-mismatch');
  assert.throws(() => F.checkPortalPin(snap, PIN), (e) => e.code === 'l1-state-unverified', 'the default accepts only an L1 light client / execution proof');
  // a contract that emits the same event from another address: ignored
  const ok = await l1.send(key, plan(viem.getAddress('0x' + '55'.repeat(20)), LEASE_DATA, 800_000n, from).l1Transaction);
  const fakeLog = { ...ok, logs: ok.logs.map((g) => ({ ...g, address: viem.getAddress('0x' + '03'.repeat(20)) })) };
  assert.throws(() => F.matchDepositEvent(plan(viem.getAddress('0x' + '55'.repeat(20)), LEASE_DATA, 800_000n, from), fakeLog, proofOf(ok), TEST_L1), (e) => /0 matching/.test(e.message));
  // and the default verifier set refuses the anvil label
  assert.throws(() => F.matchDepositEvent(plan(viem.getAddress('0x' + '55'.repeat(20)), LEASE_DATA, 800_000n, from), ok, proofOf(ok)), (e) => e.code === 'l1-receipt-unverified');
});
