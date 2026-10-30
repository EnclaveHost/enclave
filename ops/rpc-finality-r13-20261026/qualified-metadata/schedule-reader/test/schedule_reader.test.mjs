// Offline tests of schedule_reader.mjs (PREPARED). The `mockL1` below is a TEST DOUBLE ONLY: it is never live authority.
// Run: ANCHOR_DEPS_ROOT=<work>/source node --test reader/test/schedule_reader.test.mjs   (exact count: 14)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../schedule_reader.mjs';

const keccak = await R.loadKeccak(process.env.ANCHOR_DEPS_ROOT);
const Z = new Uint8Array(32), G = R.GENESIS.l2Time;
const link = (p, i, t) => R.nextLink(keccak, p, BigInt(i), BigInt(t));
const chain = (...ts) => R.hex(ts.reduce((p, t, i) => link(p, i, t), Z));
const acts = (m) => R.CONTRACT_VARIANTS.map((n) => (m[n] === undefined ? null : BigInt(m[n])));
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const abiArray = (xs, { offset = 32, len = xs.length, extra = '' } = {}) => '0x' + w(offset) + w(len) + xs.map(w).join('') + extra;
const ANCHOR = { number: 23_000_000n, hash: '0x' + 'ab'.repeat(32) };

function mockL1({ schedule, minimum = R.packVersion(R.SUPPORTED_CLIENT), finalized = [ANCHOR.number + 64n, ANCHOR.number + 70n],
                  hashes = [ANCHOR.hash, ANCHOR.hash] } = {}) {
  let f = 0, h = 0; const calls = [];
  return { calls,
    finalized: async () => ({ number: finalized[Math.min(f++, finalized.length - 1)], hash: '0x' + 'cd'.repeat(32) }),
    blockByNumber: async (n) => ({ number: n, hash: hashes[Math.min(h++, hashes.length - 1)] }),
    call: async (to, data, n) => { calls.push([to, data, n]);
      return data === R.selector(keccak, 'getSchedule()') ? schedule : '0x' + w(minimum); } };
}

test('upstream schedule_id.rs vectors (golden c04583a1..., zero, inclusive, gap, clear-above)', () => {
  assert.equal(R.pinScheduleId(keccak, acts({ regolith: 10, canyon: 20, azul: 30 }), 30n).id,
               '0xc04583a182a2a57476d1ca57f9e5e7aa24f1eee188221f75fe17634b8a63f00c');
  assert.deepEqual(R.pinScheduleId(keccak, acts({ canyon: 101 }), 99n), { id: R.hex(Z), pinnedCount: 0 });
  assert.equal(R.pinScheduleId(keccak, acts({ regolith: 10 }), 9n).id, R.hex(Z));
  assert.equal(R.pinScheduleId(keccak, acts({ regolith: 10 }), 10n).id, chain(10));
  assert.equal(R.pinScheduleId(keccak, acts({ regolith: 10, canyon: 50, delta: 30 }), 30n).id, chain(10, 50, 30));
  assert.equal(R.pinScheduleId(keccak, acts({ regolith: 10, canyon: 50, delta: 30, azul: 1000 }), 30n).id, chain(10, 50, 30));
});

test('a hole (contract 0 = unscheduled -> null) is committed as 0 inside the prefix; 0 is never the genesis convention', () => {
  const a = R.activations([10n, 0n, 30n]);
  assert.equal(a[1], null);
  assert.deepEqual(R.pinScheduleId(keccak, a, 30n), { id: chain(10, 0, 30), pinnedCount: 3 });
});

test('end-to-end anchored read: full schedule, future excluded, horizon from compiled genesis, bound L1 block, branded', async () => {
  const l1 = mockL1({ schedule: abiArray([G, G + 100n, 0n, G + 500n, G + 3000n]) });
  const r = await R.readSchedule({ l1, keccak, anchor: ANCHOR, claimedL2Block: 1000 });
  assert.equal(r.horizonTimestamp, String(G + 2000n));
  assert.equal(r.expectedScheduleId, chain(G, G + 100n, 0, G + 500n)); assert.equal(r.pinnedCount, 4);
  assert.equal(r.schedule[4].timestamp, String(G + 3000n)); assert.equal(r.schedule[2].timestamp, null);
  assert.deepEqual([r.schedule[5].contractEntry, r.contractLength, r.l1.hash, r.l1.number], [false, 5, ANCHOR.hash, '23000000']);
  assert.ok(l1.calls.every(([to, , n]) => to === R.PROTOCOL_VERSIONS && n === ANCHOR.number));
  assert.ok(R.isAccepted(r) && Object.isFrozen(r) && Object.isFrozen(r.schedule[0]));
  assert.equal(r.configHashPinCandidate.value, '0x1607709d90d40904f790574404e2ad614eac858f6162faa0ec34c6bf5e5f3c57');
});

test('boundary: an entry equal to the horizon is active (inclusive), one second later is not', async () => {
  const at = G + 2000n;
  const yes = await R.readSchedule({ l1: mockL1({ schedule: abiArray([G, at]) }), keccak, anchor: ANCHOR, claimedL2Block: 1000 });
  const no = await R.readSchedule({ l1: mockL1({ schedule: abiArray([G, at + 1n]) }), keccak, anchor: ANCHOR, claimedL2Block: 1000 });
  assert.deepEqual([yes.pinnedCount, yes.expectedScheduleId, no.pinnedCount, no.expectedScheduleId], [2, chain(G, at), 1, chain(G)]);
});

test('the schedule block (not the claim) sets the horizon; 0 means the claim; before the claim refuses', async () => {
  const s = abiArray([G, G + 2500n]);
  const a = await R.readSchedule({ l1: mockL1({ schedule: s }), keccak, anchor: ANCHOR, claimedL2Block: 1000, scheduleL2Block: 1250 });
  assert.deepEqual([a.horizonTimestamp, a.pinnedCount], [String(G + 2500n), 2]);
  const b = await R.readSchedule({ l1: mockL1({ schedule: s }), keccak, anchor: ANCHOR, claimedL2Block: 1000, scheduleL2Block: 0 });
  assert.equal(b.scheduleL2Block, '1000');
  await assert.rejects(R.readSchedule({ l1: mockL1({ schedule: s }), keccak, anchor: ANCHOR, claimedL2Block: 1000, scheduleL2Block: 999 }), { code: 'horizon' });
  await assert.rejects(R.readSchedule({ l1: mockL1({ schedule: s }), keccak, anchor: ANCHOR, claimedL2Block: 2n ** 64n }), { code: 'arithmetic' });
});

test('Denim in the authenticated schedule switches the horizon to the 200 ms schedule (rollup.rs/schedule.rs)', () => {
  const d = R.activations([G, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, G + 1001n]);   // activation block ceil(1001/2) = 501
  assert.equal(R.l2BlockTimestamp(600n, d), G + 1021n);                                    // (G+1002)*1000 + 99*200 ms, floored
  assert.equal(R.l2BlockTimestamp(500n, d), G + 1000n);                                    // still legacy below the activation block
  assert.equal(R.l2BlockTimestamp(600n, R.activations([G])), G + 1200n);
});

test('unknown extra entries and over-long declared arrays refuse; empty refuses', () => {
  assert.throws(() => R.decodeSchedule(abiArray(Array(16).fill(G))), { code: 'unknown_entries' });
  assert.throws(() => R.decodeSchedule('0x' + w(32) + w(257)), { code: 'abi' });
  assert.throws(() => R.decodeSchedule(abiArray([])), { code: 'schedule_empty' });
  assert.equal(R.decodeSchedule(abiArray(Array(15).fill(G))).length, 15);
});

test('malformed ABI refuses: offset, size, trailing word, uint64 padding, case, odd length, uint256 size', () => {
  assert.throws(() => R.decodeSchedule(abiArray([G], { offset: 64 })), { code: 'abi' });
  assert.throws(() => R.decodeSchedule(abiArray([G], { len: 2 })), { code: 'abi' });
  assert.throws(() => R.decodeSchedule(abiArray([G], { extra: w(0) })), { code: 'abi' });
  assert.throws(() => R.decodeSchedule(abiArray([1n << 64n])), { code: 'abi' });
  assert.throws(() => R.decodeSchedule(abiArray([G]).toUpperCase().replace('0X', '0x')), { code: 'abi' });
  assert.throws(() => R.decodeSchedule(abiArray([G]) + '0'), { code: 'abi' });
  assert.throws(() => R.decodeUint256('0x' + '00'.repeat(31)), { code: 'abi' });
});

test('packed semver minimum (version.rs): nonzero, <= pinned 1.5.1, prerelease below final, build ignored, unknown type refused', () => {
  const p = (major, minor, patch, prerelease = 0n) => R.packVersion({ major, minor, patch, prerelease });
  for (const ok of [p(1n, 5n, 1n), p(1n, 5n, 1n, 3n), p(1n, 4n, 9n), p(0n, 1n, 0n), (1n << 128n) | p(1n, 5n, 0n)]) R.checkMinimumVersion(ok);
  for (const bad of [0n, p(1n, 5n, 2n), p(1n, 6n, 0n, 1n), p(2n, 0n, 0n), (1n << 248n) | p(1n, 0n, 0n)])
    assert.throws(() => R.checkMinimumVersion(bad), { code: 'protocol_version' });
});

test('a contract minimum above the pinned client refuses the whole read', async () => {
  await assert.rejects(R.readSchedule({ l1: mockL1({ schedule: abiArray([G]), minimum: R.packVersion({ major: 1n, minor: 6n, patch: 0n, prerelease: 0n }) }),
                                        keccak, anchor: ANCHOR, claimedL2Block: 1 }), { code: 'protocol_version' });
});

test('anchor above the verified finalized block refuses (not_finalized)', async () => {
  await assert.rejects(R.readSchedule({ l1: mockL1({ schedule: abiArray([G]), finalized: [ANCHOR.number - 1n] }), keccak, anchor: ANCHOR, claimedL2Block: 1 }),
                       { code: 'not_finalized' });
});

test('anchor hash mismatch, a hash change during the read, and a finalized regression all refuse', async () => {
  const other = '0x' + 'ef'.repeat(32);
  await assert.rejects(R.readSchedule({ l1: mockL1({ schedule: abiArray([G]), hashes: [other] }), keccak, anchor: ANCHOR, claimedL2Block: 1 }), { code: 'anchor_mismatch' });
  await assert.rejects(R.readSchedule({ l1: mockL1({ schedule: abiArray([G]), hashes: [ANCHOR.hash, other] }), keccak, anchor: ANCHOR, claimedL2Block: 1 }),
                       { code: 'anchor_mismatch' });
  await assert.rejects(R.readSchedule({ l1: mockL1({ schedule: abiArray([G]), finalized: [ANCHOR.number + 10n, ANCHOR.number + 5n] }), keccak, anchor: ANCHOR,
                                        claimedL2Block: 1 }), { code: 'contradiction' });
  await assert.rejects(R.readSchedule({ l1: mockL1({ schedule: abiArray([G]) }), keccak, anchor: { hash: 'latest', number: 1n }, claimedL2Block: 1 }), { code: 'anchor' });
});

test('forged results (JSON round trip, spread copy, hand-built) are never accepted', async () => {
  const r = await R.readSchedule({ l1: mockL1({ schedule: abiArray([G]) }), keccak, anchor: ANCHOR, claimedL2Block: 1 });
  for (const f of [JSON.parse(JSON.stringify(r)), { ...r }, { format: R.FORMAT, expectedScheduleId: r.expectedScheduleId }, null]) {
    assert.equal(R.isAccepted(f), false);
    assert.throws(() => R.assertAccepted(f), { code: 'forged' });
  }
  assert.throws(() => { r.expectedScheduleId = R.hex(Z); }, TypeError);                     // frozen
});

test('source pins: 8453, the 0x7480... reader address, exactly 15 entries in registration order', () => {
  assert.equal(R.CHAIN_ID, 8453); assert.equal(R.PROTOCOL_VERSIONS, '0x7480afc8d99a5c645c247db5a1e4a4f440e6e095');
  assert.deepEqual(R.CONTRACT_VARIANTS, ['regolith', 'canyon', 'delta', 'ecotone', 'fjord', 'granite', 'holocene', 'pectra_blob_schedule',
    'isthmus', 'jovian', 'azul', 'beryl', 'cobalt', 'denim', 'everest']);
  assert.deepEqual([R.GENESIS.l2Time, R.GENESIS.l2Number, R.GENESIS.blockTime], [1686789347n, 0n, 2n]);
});
