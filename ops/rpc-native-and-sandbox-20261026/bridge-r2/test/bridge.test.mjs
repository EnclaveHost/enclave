// Offline tests of integration-r2/bridge.mjs (PREPARED). mockL1 is a TEST DOUBLE (never live authority); the native result objects are
// hand-built shapes of the r4 harness stdout, used only to test acceptNativeResult's binding (r4 has not been built or run).
// Run: ANCHOR_DEPS_ROOT=<work>/source node --test integration-r2/test/bridge.test.mjs   (exact count: 14)
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
const SCHED = [G, G, G, G + 10n, G + 20n, G + 30n, G + 40n, G + 50n, G + 60n, G + 70n, G + 80n, G + 90n, G + 100n, 0n];
const read = (o = {}) => R.readSchedule({ l1: mockL1(abi(o.sched || SCHED)), keccak, anchor: ANCHOR, claimedL2Block: 1000, ...o.args });
const AGREED = '0x' + '22'.repeat(32), CLAIM = { l2OutputRoot: '0x' + '33'.repeat(32), l2BlockNumber: 1000 };
const TEMPLATE = { l2_chain_id: 8453, block_time: 2, regolith_time: 0, canyon_time: 1, base: { v1: 5, beryl: 6, denim: 7, zenith: 9 } };
const args = (accepted, o = {}) => ({ accepted, anchor: { hash: ANCHOR.hash, number: ANCHOR.number }, agreedL2OutputRoot: AGREED, agreedL2BlockNumber: 900,
  claim: CLAIM, rollupConfigTemplate: TEMPLATE, expectedRollupConfigHash: R.CONFIG_HASH_PIN_CANDIDATE.value, intermediateBlockInterval: 50, ...o });
const native = (input, o = {}) => ({ format: B.RESULT_FORMAT, chainId: 8453, l1Head: input.trusted.l1Head, l1HeadNumber: input.trusted.l1HeadNumber,
  agreedL2OutputRoot: AGREED, l2PreBlockNumber: 900, l2OutputRoot: CLAIM.l2OutputRoot, l2BlockNumber: 1000,
  rollupConfigHash: input.trusted.expectedRollupConfigHash, scheduleId: input.trusted.expectedScheduleId, intermediateBlockInterval: 50,
  intermediateRoots: '0x' + 'aa'.repeat(32) + CLAIM.l2OutputRoot.slice(2), bootInfoAbi: '0x', bootInfoKeccak: '0x' + '00'.repeat(32), ...o });

test('builds exactly the r4 TRUSTED_KEYS (10, interval last), bound to the accepted schedule, anchor and caller inputs', async () => {
  const a = await read(); const { trusted, bytes, candidate, bound } = B.buildTrustedInput(args(a));
  assert.deepEqual(Object.keys(trusted), [...B.TRUSTED_KEYS]); assert.equal(B.TRUSTED_KEYS.length, 10);
  assert.deepEqual([trusted.chainId, trusted.l1Head, trusted.l1HeadNumber, trusted.agreedL2OutputRoot, trusted.claimedL2OutputRoot, trusted.claimedL2BlockNumber,
                    trusted.intermediateBlockInterval, bound.agreedL2BlockNumber], [8453, ANCHOR.hash, 23000000, AGREED, CLAIM.l2OutputRoot, 1000, 50, 900]);
  assert.deepEqual([trusted.expectedScheduleId, trusted.expectedRollupConfigHash], [a.expectedScheduleId, R.CONFIG_HASH_PIN_CANDIDATE.value]);
  assert.deepEqual(JSON.parse(bytes), JSON.parse(JSON.stringify(trusted))); assert.match(candidate.status, /untrusted/);
  assert.equal('agreedL2BlockNumber' in trusted, false);                    // not a native key: bound on the result instead
});

test('rollupConfig: all 15 upstream serde keys come from the authenticated schedule; None absent; aliases removed', async () => {
  const c = B.buildTrustedInput(args(await read())).trusted.rollupConfig;
  assert.deepEqual([c.regolith_time, c.canyon_time, c.ecotone_time, c.jovian_time, c.base.azul, c.base.beryl, c.base.cobalt],
                   [Number(G), Number(G), Number(G + 10n), Number(G + 70n), Number(G + 80n), Number(G + 90n), Number(G + 100n)]);
  assert.equal('denim' in c.base, false); assert.equal('everest' in c.base, false); assert.equal('v1' in c.base, false);
});

test('missing, zero, negative, fractional, string, unsafe-large interval refuses (code interval)', async () => {
  const a = await read();
  for (const v of [undefined, null, 0, 0n, -50, 1.5, '50', Number.MAX_SAFE_INTEGER + 1, 2n ** 64n])
    assert.throws(() => B.buildTrustedInput(args(a, { intermediateBlockInterval: v })), { code: 'interval' }, String(v));
});

test('upstream sampler rules before any run: non-dividing interval (PartialInterval) and empty range refuse', async () => {
  const a = await read();
  assert.throws(() => B.buildTrustedInput(args(a, { intermediateBlockInterval: 30 })), { code: 'interval' });      // 100 % 30 != 0
  assert.throws(() => B.buildTrustedInput(args(a, { agreedL2BlockNumber: 1000 })), { code: 'interval' });          // empty range
  assert.throws(() => B.buildTrustedInput(args(a, { agreedL2BlockNumber: 1001 })), { code: 'interval' });
  assert.equal(B.buildTrustedInput(args(a, { intermediateBlockInterval: 100 })).trusted.intermediateBlockInterval, 100);   // whole range
  assert.equal(B.buildTrustedInput(args(a, { intermediateBlockInterval: 1 })).trusted.intermediateBlockInterval, 1);
});

test('a caller anchor different from the authenticated block refuses', async () => {
  const a = await read();
  assert.throws(() => B.buildTrustedInput(args(a, { anchor: { hash: '0x' + 'ef'.repeat(32), number: ANCHOR.number } })), { code: 'anchor' });
  assert.throws(() => B.buildTrustedInput(args(a, { anchor: { hash: ANCHOR.hash, number: ANCHOR.number + 1n } })), { code: 'anchor' });
});

test('a candidate claim for another block, or a horizon other than the claim, refuses', async () => {
  const a = await read();
  assert.throws(() => B.buildTrustedInput(args(a, { claim: { ...CLAIM, l2BlockNumber: 1001 } })), { code: 'claim' });
  assert.throws(() => B.buildTrustedInput(args(a, { claim: { ...CLAIM, l2OutputRoot: '0x33' } })), { code: 'input' });
  const later = await read({ args: { scheduleL2Block: 1200 } });
  assert.throws(() => B.buildTrustedInput(args(later)), { code: 'horizon' });
  assert.throws(() => B.buildTrustedInput(args(a, { agreedL2OutputRoot: 'latest' })), { code: 'input' });
});

test('a forged (JSON-copied or hand-built) reader result refuses', async () => {
  const a = await read();
  for (const f of [JSON.parse(JSON.stringify(a)), { ...a }]) assert.throws(() => B.buildTrustedInput(args(f)), { code: 'forged' });
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

test('native result: the full binding (incl. interval, pre block, roots) is accepted', async () => {
  const input = B.buildTrustedInput(args(await read()));
  const v = B.acceptNativeResult(native(input), input);
  assert.deepEqual([v.verified, v.base.number, v.base.outputRoot], ['native-derivation-bound', 1000, CLAIM.l2OutputRoot]); assert.match(v.notAProvider, /unauthenticated/);
});

test('native result: interval, pre block, roots (count, last, malformed) mismatches refuse', async () => {
  const input = B.buildTrustedInput(args(await read()));
  for (const o of [{ intermediateBlockInterval: 100 }, { intermediateBlockInterval: undefined }, { l2PreBlockNumber: 950 },
                   { intermediateRoots: '0x' + CLAIM.l2OutputRoot.slice(2) }, { intermediateRoots: '0x' + CLAIM.l2OutputRoot.slice(2) + 'aa'.repeat(32) },
                   { intermediateRoots: '0x' }, { intermediateRoots: '0x' + 'AA'.repeat(32) + CLAIM.l2OutputRoot.slice(2) }, { intermediateRoots: undefined }])
    assert.throws(() => B.acceptNativeResult(native(input, o), input), { code: 'native' }, JSON.stringify(o));
  assert.throws(() => B.acceptNativeResult(native(input), input.trusted), { code: 'native' });   // the old r1 call shape refuses
});

test('native result: config hash, schedule, root, number, L1, agreed mismatches and refusals refuse', async () => {
  const input = B.buildTrustedInput(args(await read()));
  assert.throws(() => B.acceptNativeResult(native(input, { rollupConfigHash: '0x' + '55'.repeat(32) }), input), { code: 'config_hash' });
  assert.throws(() => B.acceptNativeResult(native(input, { scheduleId: '0x' + '44'.repeat(32) }), input), { code: 'schedule' });
  for (const k of ['l2OutputRoot', 'l1Head', 'agreedL2OutputRoot']) assert.throws(() => B.acceptNativeResult(native(input, { [k]: '0x' + '99'.repeat(32) }), input), { code: 'native' });
  assert.throws(() => B.acceptNativeResult(native(input, { l2BlockNumber: 999 }), input), { code: 'native' });
  assert.throws(() => B.acceptNativeResult({ format: B.RESULT_FORMAT, refused: 'x' }, input), { code: 'native' });
});

test('an omitted or wrong upgrade schedule cannot pass the native binding', async () => {
  const a = await read(), b = await read({ sched: SCHED.slice(0, 12) });     // Cobalt (index 12) omitted
  assert.notEqual(a.expectedScheduleId, b.expectedScheduleId);
  const input = B.buildTrustedInput(args(a));
  assert.throws(() => B.acceptNativeResult(native(input, { scheduleId: b.expectedScheduleId }), input), { code: 'schedule' });
  assert.equal('cobalt' in (B.scheduleRollupConfig(TEMPLATE, b).base || {}), false);
});

test('the bridge refuses a reader that is not the frozen sha', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-')); const p = path.join(d, 'r.mjs');
  fs.writeFileSync(p, fs.readFileSync(B.READER_PATH, 'utf8') + '\n// tampered\n');
  assert.throws(() => B.verifyReaderPin(p), { code: 'reader_pin' }); B.verifyReaderPin();
  fs.rmSync(d, { recursive: true });
});
