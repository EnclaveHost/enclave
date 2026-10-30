// Offline tests of integration-r1/bridge.mjs (PREPARED). mockL1 is a TEST DOUBLE (never live authority); the native result objects
// below are hand-built shapes of r3's stdout, used only to test acceptNativeResult's binding checks (r3 itself has not run).
// Run: ANCHOR_DEPS_ROOT=<work>/source node --test integration-r1/test/bridge.test.mjs   (exact count: 10)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as B from '../bridge.mjs';
const R = await import(B.READER_PATH);                                  // the SAME module instance the bridge pinned and imported

const keccak = await R.loadKeccak(process.env.ANCHOR_DEPS_ROOT);
const G = R.GENESIS.l2Time, ANCHOR = { number: 23_000_000n, hash: '0x' + 'ab'.repeat(32) };
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const abi = (xs) => '0x' + w(32) + w(xs.length) + xs.map(w).join('');
const mockL1 = (schedule) => ({ finalized: async () => ({ number: ANCHOR.number + 64n, hash: '0x' + 'cd'.repeat(32) }),
  blockByNumber: async (n) => ({ number: n, hash: ANCHOR.hash }),
  call: async (to, data) => (data === R.selector(keccak, 'getSchedule()') ? schedule : '0x' + w(R.packVersion(R.SUPPORTED_CLIENT))) });
// a 14-entry schedule: Denim 0 (unscheduled), everything else genesis-active or past; Everest has no contract entry
const SCHED = [G, G, G, G + 10n, G + 20n, G + 30n, G + 40n, G + 50n, G + 60n, G + 70n, G + 80n, G + 90n, G + 100n, 0n];
const read = (o = {}) => R.readSchedule({ l1: mockL1(abi(o.sched || SCHED)), keccak, anchor: ANCHOR, claimedL2Block: 1000, ...o.args });
const AGREED = '0x' + '22'.repeat(32), CLAIM = { l2OutputRoot: '0x' + '33'.repeat(32), l2BlockNumber: 1000 };
// untrusted host template: wrong schedule values + alias spellings + a stale denim; only shape matters for chain 8453
const TEMPLATE = { l2_chain_id: 8453, block_time: 2, regolith_time: 0, canyon_time: 1, base: { v1: 5, beryl: 6, denim: 7, zenith: 9 } };
const args = (accepted, o = {}) => ({ accepted, anchor: { hash: ANCHOR.hash, number: ANCHOR.number }, agreedL2OutputRoot: AGREED, claim: CLAIM,
  rollupConfigTemplate: TEMPLATE, expectedRollupConfigHash: R.CONFIG_HASH_PIN_CANDIDATE.value, ...o });

test('builds exactly r3 TRUSTED_KEYS, bound to the accepted schedule, anchor and caller inputs', async () => {
  const a = await read(); const { trusted, bytes, candidate } = B.buildTrustedInput(args(a));
  assert.deepEqual(Object.keys(trusted), [...B.TRUSTED_KEYS]);
  assert.deepEqual([trusted.chainId, trusted.l1Head, trusted.l1HeadNumber, trusted.agreedL2OutputRoot, trusted.claimedL2OutputRoot, trusted.claimedL2BlockNumber],
                   [8453, ANCHOR.hash, 23000000, AGREED, CLAIM.l2OutputRoot, 1000]);
  assert.deepEqual([trusted.expectedScheduleId, trusted.expectedRollupConfigHash], [a.expectedScheduleId, R.CONFIG_HASH_PIN_CANDIDATE.value]);
  assert.deepEqual(JSON.parse(bytes), JSON.parse(JSON.stringify(trusted))); assert.match(candidate.status, /untrusted/);
  assert.ok(Object.isFrozen(trusted.rollupConfig));
});

test('rollupConfig: all 15 upstream serde keys come from the authenticated schedule; None is absent; aliases removed; host values never survive', async () => {
  const c = (await B.buildTrustedInput(args(await read()))).trusted.rollupConfig;
  assert.deepEqual([c.regolith_time, c.canyon_time, c.delta_time, c.ecotone_time, c.jovian_time], [Number(G), Number(G), Number(G), Number(G + 10n), Number(G + 70n)]);
  assert.deepEqual([c.base.azul, c.base.beryl, c.base.cobalt], [Number(G + 80n), Number(G + 90n), Number(G + 100n)]);
  assert.equal('denim' in c.base, false); assert.equal('everest' in c.base, false); assert.equal('v1' in c.base, false);   // contract 0 / no entry
  assert.equal(c.base.zenith, 9); assert.equal(c.block_time, 2);                // not contract-backed / static: ignored by BootInfo for 8453
});

test('a caller anchor different from the authenticated block refuses', async () => {
  const a = await read();
  assert.throws(() => B.buildTrustedInput(args(a, { anchor: { hash: '0x' + 'ef'.repeat(32), number: ANCHOR.number } })), { code: 'anchor' });
  assert.throws(() => B.buildTrustedInput(args(a, { anchor: { hash: ANCHOR.hash, number: ANCHOR.number + 1n } })), { code: 'anchor' });
});

test('a candidate claim for another block, or a schedule horizon other than the claim (native has no schedule key), refuses', async () => {
  const a = await read();
  assert.throws(() => B.buildTrustedInput(args(a, { claim: { ...CLAIM, l2BlockNumber: 1001 } })), { code: 'claim' });
  assert.throws(() => B.buildTrustedInput(args(a, { claim: { ...CLAIM, l2OutputRoot: '0x33' } })), { code: 'input' });
  const later = await read({ args: { scheduleL2Block: 1200 } });
  assert.throws(() => B.buildTrustedInput(args(later, { claim: CLAIM })), { code: 'horizon' });
  assert.throws(() => B.buildTrustedInput(args(a, { agreedL2OutputRoot: 'latest' })), { code: 'input' });
});

test('a forged (JSON-copied or hand-built) reader result refuses', async () => {
  const a = await read();
  for (const f of [JSON.parse(JSON.stringify(a)), { ...a }]) assert.throws(() => B.buildTrustedInput(args(f)), { code: 'forged' });
  assert.throws(() => B.scheduleRollupConfig(TEMPLATE, { ...a }), { code: 'forged' });
});

test('an expected config hash other than the source pin candidate refuses', async () => {
  const a = await read();
  assert.throws(() => B.buildTrustedInput(args(a, { expectedRollupConfigHash: '0x' + '55'.repeat(32) })), { code: 'config_hash' });
});

test('a template for another chain, without a chain id, or not an object refuses', async () => {
  const a = await read();
  for (const t of [{ ...TEMPLATE, l2_chain_id: 84532 }, { block_time: 2 }, [], null, { ...TEMPLATE, base: 5 }])
    assert.throws(() => B.buildTrustedInput(args(a, { rollupConfigTemplate: t })), { code: 'rollup_config' });
});

test('native result: only a full binding is accepted; config hash, schedule, root, number, anchor mismatches and refusals refuse', async () => {
  const { trusted } = B.buildTrustedInput(args(await read()));
  const ok = { format: B.RESULT_FORMAT, chainId: 8453, l1Head: trusted.l1Head, l1HeadNumber: trusted.l1HeadNumber, agreedL2OutputRoot: AGREED,
    l2PreBlockNumber: 900, l2OutputRoot: CLAIM.l2OutputRoot, l2BlockNumber: 1000, rollupConfigHash: trusted.expectedRollupConfigHash,
    scheduleId: trusted.expectedScheduleId, bootInfoAbi: '0x', bootInfoKeccak: '0x' + '00'.repeat(32) };
  const v = B.acceptNativeResult(ok, trusted);
  assert.deepEqual([v.verified, v.base.number, v.base.outputRoot], ['native-derivation-bound', 1000, CLAIM.l2OutputRoot]); assert.match(v.notAProvider, /unauthenticated/);
  assert.throws(() => B.acceptNativeResult({ ...ok, rollupConfigHash: '0x' + '55'.repeat(32) }, trusted), { code: 'config_hash' });
  assert.throws(() => B.acceptNativeResult({ ...ok, scheduleId: '0x' + '44'.repeat(32) }, trusted), { code: 'schedule' });
  for (const k of ['l2OutputRoot', 'l1Head', 'agreedL2OutputRoot']) assert.throws(() => B.acceptNativeResult({ ...ok, [k]: '0x' + '99'.repeat(32) }, trusted), { code: 'native' });
  assert.throws(() => B.acceptNativeResult({ ...ok, l2BlockNumber: 999 }, trusted), { code: 'native' });
  assert.throws(() => B.acceptNativeResult({ format: B.RESULT_FORMAT, refused: 'x' }, trusted), { code: 'native' });
});

test('an omitted or wrong upgrade schedule cannot pass: a different schedule changes expectedScheduleId and the native binding refuses', async () => {
  const a = await read(), b = await read({ sched: SCHED.slice(0, 12) });     // Cobalt (index 12) omitted
  assert.notEqual(a.expectedScheduleId, b.expectedScheduleId);
  const { trusted } = B.buildTrustedInput(args(a));
  const native = { format: B.RESULT_FORMAT, chainId: 8453, l1Head: trusted.l1Head, l1HeadNumber: trusted.l1HeadNumber, agreedL2OutputRoot: AGREED,
    l2OutputRoot: CLAIM.l2OutputRoot, l2BlockNumber: 1000, rollupConfigHash: trusted.expectedRollupConfigHash, scheduleId: b.expectedScheduleId };
  assert.throws(() => B.acceptNativeResult(native, trusted), { code: 'schedule' });
  const cfgB = B.scheduleRollupConfig(TEMPLATE, b);
  assert.equal('cobalt' in (cfgB.base || {}), false);
});

test('the bridge refuses a reader that is not the frozen sha', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-')); const p = path.join(d, 'r.mjs');
  fs.writeFileSync(p, fs.readFileSync(B.READER_PATH, 'utf8') + '\n// tampered\n');
  assert.throws(() => B.verifyReaderPin(p), { code: 'reader_pin' }); B.verifyReaderPin();
  fs.rmSync(d, { recursive: true });
});
