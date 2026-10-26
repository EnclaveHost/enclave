// derivation-schedule-auth-stage/reader/schedule_reader.mjs (50cf; PREPARED). Authenticated Base mainnet upgrade-schedule reader.
//
// Computes the proof client's expectedScheduleId from the L1 ProtocolVersions schedule, read through the in-domain Helios
// (light-client-VERIFIED eth_call) at ONE trusted, finalized L1 block. Source of every rule: upstream base 5476069f (vendor-inspect
// base-v1.5.1), cited per constant. No storage-layout proof and no `activatedScheduleId` ABI is assumed: only the source-grounded
// read interface `getSchedule() returns (uint64[])` / `minimumProtocolVersion() returns (uint256)` (upgrade-signal/src/contract.rs).
//
// CALLER TRUST CONTRACT (internal; the reader cannot check these, the caller must guarantee them):
//   1. `l1` is the in-domain, pinned Helios (l1-authority binary/config) reached over loopback: its eth_getBlockByNumber and eth_call
//      results are verified by the Helios light client against beacon-finalized headers. A raw execution RPC is NOT acceptable.
//   2. `anchor` {hash, number} comes from the trusted in-domain finality authority and is the SAME L1 block the proof claim is judged
//      against (the derivation client's l1Head/l1HeadNumber). It is never a provider label ("finalized"/"latest") or an ASR/unsafe head.
//   3. `claimedL2Block` / `scheduleL2Block` are exactly the values the proof client receives (L2_CLAIM_BLOCK_NUMBER_KEY /
//      L2_SCHEDULE_BLOCK_NUMBER_KEY; schedule 0 or absent = the claim, boot.rs).
// The reader itself checks: anchor <= Helios finalized number (before AND after), Helios block(anchor.number).hash == anchor.hash
// (before AND after both calls; any change refuses), exact ABI shape/bounds, contract minimum protocol version, and the algorithm.
// Accepted results are frozen and branded (module-private WeakSet): a JSON copy or a hand-built object is never `isAccepted`.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export const FORMAT = 'enclave-base-schedule-auth/v1';
export const CHAIN_ID = 8453;                                               // base-common-chains MAINNET.chain_id (chains/src/config.rs:456)
export const PROTOCOL_VERSIONS = '0x7480afc8d99a5c645c247db5a1e4a4f440e6e095';  // upgrade-signal/src/config/args.rs:41 (8453 default)
// BaseUpgrade::CONTRACT_VARIANTS (common/genesis/src/chain/upgrade.rs:169-185): index == contract registration id. Append-only.
export const CONTRACT_VARIANTS = Object.freeze(['regolith', 'canyon', 'delta', 'ecotone', 'fjord', 'granite', 'holocene',
  'pectra_blob_schedule', 'isthmus', 'jovian', 'azul', 'beryl', 'cobalt', 'denim', 'everest']);
const DENIM = 13;
// compiled MAINNET (chains/src/config.rs:455-485): block_time 2, genesis_l2_number 0, genesis_l2_time 1_686_789_347
export const GENESIS = Object.freeze({ l2Time: 1686789347n, l2Number: 0n, blockTime: 2n });
export const DENIM_BLOCK_INTERVAL_MILLIS = 200n;                            // genesis/src/schedule.rs:25
export const MAX_SCHEDULE_ABI_ENTRIES = 256;                                // upgrade-signal README: reject > 256 before decoding
// rollupConfigHash: upstream-test-asserted (zk/utils/src/boot.rs test_config_hash_matches_nitro_enclave); NOT computed here
export const CONFIG_HASH_PIN_CANDIDATE = Object.freeze({ value: '0x1607709d90d40904f790574404e2ad614eac858f6162faa0ec34c6bf5e5f3c57',
  status: 'source-pin-candidate: valid only after the native client computes the same rollupConfigHash' });
const U64 = (1n << 64n) - 1n, U32 = (1n << 32n) - 1n;
// the native proof client this schedule must be supported by: upstream workspace version 1.5.1 (Cargo.toml [workspace.package])
export const SUPPORTED_CLIENT = Object.freeze({ major: 1n, minor: 5n, patch: 1n, prerelease: 0n });
const LOCK_SHA256 = '9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20';   // source/package-lock.json (@noble/hashes 1.8.0)

export class Refused extends Error {
  constructor(code, msg) { super(`${code}: ${msg}`); this.code = code; }
}
const refuse = (code, msg) => { throw new Refused(code, msg); };

// ---- keccak: the EXISTING dependency (noble 1.8.0 in the pinned source/package-lock.json), loaded only after the lock verifies ----
export async function loadKeccak(depsRoot) {
  const lock = fs.readFileSync(path.join(depsRoot, 'package-lock.json'));
  if (crypto.createHash('sha256').update(lock).digest('hex') !== LOCK_SHA256) refuse('deps', 'package-lock.json is not the pinned lock');
  const m = await import(path.join(depsRoot, 'node_modules/@noble/hashes/sha3.js'));
  const k = (b) => m.keccak_256(b);
  if (hex(k(new Uint8Array(0))) !== '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') refuse('deps', 'keccak self-test');
  return k;
}

// ---- strict hex / ABI ---------------------------------------------------------------------------------------------------
export const hex = (b) => '0x' + Buffer.from(b).toString('hex');
export function bytesOf(h, what) {
  if (typeof h !== 'string' || !/^0x([0-9a-f]{2})*$/.test(h)) refuse('abi', `${what} is not lowercase even-length 0x-hex`);
  return Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
}
const word = (b, i) => BigInt('0x' + (Buffer.from(b.subarray(i * 32, i * 32 + 32)).toString('hex') || '0'));
export function selector(keccak, sig) { return hex(keccak(new TextEncoder().encode(sig)).subarray(0, 4)); }

/** `uint64[]` return data: offset word == 0x20, length <= 15 (more = an upgrade this client does not know: refuse), exact size,
 *  every element a zero-padded uint64. -> BigInt[] (0 = not scheduled, contract semantics). */
export function decodeSchedule(h) {
  const b = bytesOf(h, 'getSchedule result');
  if (b.length < 64 || b.length % 32) refuse('abi', `getSchedule result is ${b.length} bytes`);
  if (word(b, 0) !== 32n) refuse('abi', 'non-canonical dynamic offset');
  const n = word(b, 1);
  if (n > BigInt(MAX_SCHEDULE_ABI_ENTRIES)) refuse('abi', `declared length ${n} > ${MAX_SCHEDULE_ABI_ENTRIES}`);
  if (BigInt(b.length) !== 64n + 32n * n) refuse('abi', 'size != 64 + 32 * length');
  if (n === 0n) refuse('schedule_empty', 'empty schedule');
  if (n > BigInt(CONTRACT_VARIANTS.length)) refuse('unknown_entries', `${n} entries > the ${CONTRACT_VARIANTS.length} this client knows`);
  const out = [];
  for (let i = 0n; i < n; i++) {
    const v = word(b, Number(2n + i));
    if (v > U64) refuse('abi', `entry ${i} is not a uint64`);
    out.push(v);
  }
  return out;
}
export function decodeUint256(h) {
  const b = bytesOf(h, 'uint256 result');
  if (b.length !== 32) refuse('abi', `uint256 result is ${b.length} bytes`);
  return word(b, 0);
}

// ---- packed semver (upgrade-signal/src/version.rs PackedProtocolVersion) ------------------------------------------------
export function unpackVersion(v) {
  return { versionType: v >> 248n, major: (v >> 96n) & U32, minor: (v >> 64n) & U32, patch: (v >> 32n) & U32, prerelease: v & U32 };
}
export const packVersion = ({ major, minor, patch, prerelease }) => (major << 96n) | (minor << 64n) | (patch << 32n) | prerelease;
const orderingKey = (p) => [p.versionType, p.major, p.minor, p.patch, p.prerelease === 0n ? U64 : p.prerelease];
export function compareVersions(a, b) {                                   // build + reserved bits ignored (version.rs ordering_key)
  const x = orderingKey(unpackVersion(a)), y = orderingKey(unpackVersion(b));
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
export function checkMinimumVersion(minimum, supported = packVersion(SUPPORTED_CLIENT)) {
  if (minimum === 0n) refuse('protocol_version', 'the contract minimum protocol version is zero');
  if (compareVersions(minimum, supported) > 0) refuse('protocol_version', 'the contract requires a newer client than the pinned one');
  return unpackVersion(minimum);
}

// ---- schedule -> activations -> horizon -> schedule id (proof/src/schedule_id.rs, boot.rs) -------------------------------
/** contract 0 = UNSCHEDULED -> null (never the legacy Some(0) genesis convention); a missing entry -> null */
export function activations(schedule) {
  return CONTRACT_VARIANTS.map((_, i) => (i < schedule.length && schedule[i] !== 0n ? schedule[i] : null));
}
function checkedU64(x, what) { if (x < 0n || x > U64) refuse('arithmetic', `${what} out of u64`); return x; }
/** rollup.rs l2_block_timestamp: the Denim millisecond schedule when Denim is configured (from THIS schedule), else legacy seconds */
export function l2BlockTimestamp(block, acts, g = GENESIS) {
  checkedU64(block, 'block');
  if (block < g.l2Number) refuse('horizon', 'block before L2 genesis');
  const since = block - g.l2Number, denim = acts[DENIM];
  if (denim === null) return checkedU64(g.l2Time + since * g.blockTime, 'timestamp');
  const actBlock = denim <= g.l2Time ? 0n : (denim - g.l2Time + g.blockTime - 1n) / g.blockTime;   // saturating_sub then div_ceil
  if (since < actBlock) return checkedU64((g.l2Time + since * g.blockTime) * 1000n, 'millis') / 1000n;
  const millis = (g.l2Time + actBlock * g.blockTime) * 1000n + (since - actBlock) * DENIM_BLOCK_INTERVAL_MILLIS;
  return checkedU64(millis, 'millis') / 1000n;
}
export function horizon(claimedL2Block, scheduleL2Block, acts, g = GENESIS) {
  const claim = checkedU64(BigInt(claimedL2Block), 'claimed block');
  let sched = scheduleL2Block === undefined || scheduleL2Block === null ? 0n : checkedU64(BigInt(scheduleL2Block), 'schedule block');
  if (sched === 0n) sched = claim;                                        // boot.rs: missing or zero = the claimed block
  if (claim < g.l2Number) refuse('horizon', 'claim before L2 genesis');
  if (sched < claim) refuse('horizon', 'schedule block before the claimed block');
  return { claim, sched, timestamp: l2BlockTimestamp(sched, acts, g) };
}
export function nextLink(keccak, prev, index, ts) {
  const buf = new Uint8Array(96);
  buf.set(prev, 0); buf.set(Buffer.from(index.toString(16).padStart(64, '0'), 'hex'), 32); buf.set(Buffer.from(ts.toString(16).padStart(64, '0'), 'hex'), 64);
  return keccak(buf);
}
/** ScheduleId::pin: prefix through the highest entry active at `ts` (inclusive), holes = 0, entries above the prefix excluded */
export function pinScheduleId(keccak, acts, ts) {
  let pinned = 0;
  for (let i = acts.length - 1; i >= 0; i--) if (acts[i] !== null && acts[i] <= ts) { pinned = i + 1; break; }
  let id = new Uint8Array(32);
  for (let i = 0; i < pinned; i++) id = nextLink(keccak, id, BigInt(i), acts[i] ?? 0n);
  return { id: hex(id), pinnedCount: pinned };
}

// ---- the anchored, verified read ------------------------------------------------------------------------------------------
const ACCEPTED = new WeakSet();
export const isAccepted = (r) => typeof r === 'object' && r !== null && ACCEPTED.has(r);
export function assertAccepted(r) { if (!isAccepted(r)) refuse('forged', 'not a result accepted by this reader'); return r; }
const HASH = /^0x[0-9a-f]{64}$/;

/** l1: { finalized() -> {number: bigint, hash}, blockByNumber(bigint) -> {number, hash}, call(to, data, number: bigint) -> hex }
 *  (production: helios_l1.mjs heliosL1(url)). Any contradiction refuses; nothing is cached across calls. */
export async function readSchedule({ l1, keccak, anchor, claimedL2Block, scheduleL2Block }) {
  if (!anchor || !HASH.test(anchor.hash) || typeof anchor.number !== 'bigint') refuse('anchor', 'anchor must be {hash: 0x64-hex, number: bigint}');
  checkedU64(anchor.number, 'anchor number');
  const pinBlock = async (when) => {
    const f = await l1.finalized();
    if (typeof f?.number !== 'bigint' || !HASH.test(f?.hash)) refuse('l1', `${when}: malformed finalized block`);
    if (anchor.number > f.number) refuse('not_finalized', `${when}: anchor ${anchor.number} is above the verified finalized ${f.number}`);
    const b = await l1.blockByNumber(anchor.number);
    if (b?.number !== anchor.number || b?.hash !== anchor.hash) refuse('anchor_mismatch', `${when}: L1 block ${anchor.number} is not the anchor hash`);
    return f.number;
  };
  const f1 = await pinBlock('before');
  const getSchedule = await l1.call(PROTOCOL_VERSIONS, selector(keccak, 'getSchedule()'), anchor.number);
  const minimum = await l1.call(PROTOCOL_VERSIONS, selector(keccak, 'minimumProtocolVersion()'), anchor.number);
  const f2 = await pinBlock('after');
  if (f2 < f1) refuse('contradiction', 'the verified finalized block went backwards during the read');
  const schedule = decodeSchedule(getSchedule);
  const mv = checkMinimumVersion(decodeUint256(minimum));
  const acts = activations(schedule);
  const hz = horizon(claimedL2Block, scheduleL2Block, acts);
  const { id, pinnedCount } = pinScheduleId(keccak, acts, hz.timestamp);
  const r = deepFreeze({
    format: FORMAT, chainId: CHAIN_ID, contract: PROTOCOL_VERSIONS,
    l1: { hash: anchor.hash, number: anchor.number.toString() },
    schedule: CONTRACT_VARIANTS.map((name, i) => ({ index: i, name, timestamp: acts[i] === null ? null : acts[i].toString(),
                                                    contractEntry: i < schedule.length })),
    contractLength: schedule.length,
    minimumProtocolVersion: { major: Number(mv.major), minor: Number(mv.minor), patch: Number(mv.patch), prerelease: Number(mv.prerelease) },
    claimedL2Block: hz.claim.toString(), scheduleL2Block: hz.sched.toString(), horizonTimestamp: hz.timestamp.toString(),
    pinnedCount, expectedScheduleId: id, configHashPinCandidate: CONFIG_HASH_PIN_CANDIDATE });
  ACCEPTED.add(r);
  return r;
}
function deepFreeze(o) { Object.values(o).forEach((v) => typeof v === 'object' && v !== null && deepFreeze(v)); return Object.freeze(o); }
