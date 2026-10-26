// derivation-schedule-auth-stage/integration-r2/bridge.mjs (50cf; PREPARED; r1 frozen). Internal bridge: frozen schedule reader -> the
// native harness's caller-owned trusted input (derivation-client-stage/r4 derivation_harness.rs TRUSTED_KEYS, 10 keys), and back.
// r2: + caller-authorized intermediateBlockInterval (upstream BootInfo::load REQUIRES INTERMEDIATE_BLOCK_INTERVAL_KEY as a non-zero u64;
// IntermediateRootSampler requires (claim - agreed) to be a NON-ZERO MULTIPLE of it, else EmptyRange/PartialInterval) and the
// caller-authorized agreed block number. Commitment effect: BootInfoStruct commits intermediateBlockInterval + intermediateRoots (one
// root per interval, the last == the claim) into bootInfoAbi/bootInfoKeccak; the interval is NOT in the on-chain proposal journal, and
// upstream aggregation requires every aggregated range to share it. It changes WHICH roots are committed, never the derived chain.
// NOT a lifecycle readAnchor provider (see ../../logs/claude-schedule-integration.md): it authenticates no Base header and runs nothing.
//
// Source grounding (upstream base 5476069f, vendor-inspect base-v1.5.1):
//  - boot.rs BootInfo::load: for chain 8453 the COMPILED config supplies every static derivation parameter; from the oracle-served
//    rollup config only `l2_chain_id` (must equal the boot chain id) and the 15 CONTRACT_VARIANTS activations are used
//    (apply_upgrade_activation: Some(t) -> Timestamp(t), None -> Never = cleared). The schedule horizon is L2_SCHEDULE_BLOCK_NUMBER_KEY,
//    absent -> the claimed block. r3 never injects that key, so the horizon IS the claimed block: the bridge refuses any other.
//  - genesis/src/rollup.rs RollupConfig serde (deny_unknown_fields; `upgrades` flattened) and chain/upgrade.rs UpgradeConfig serde:
//    top-level regolith_time, canyon_time, delta_time, ecotone_time, fjord_time, granite_time, holocene_time,
//    pectra_blob_schedule_time, isthmus_time, jovian_time; nested `base` {azul (alias v1), beryl (v2), cobalt (v3), denim, everest,
//    zenith (alias future)}; Option None == key absent (skip_serializing_if).
// Trust: the reader result must be branded by the frozen reader; the agreed root and the L1 anchor are caller-authorized (the anchor
// must be the reader's bound block); the claim is an UNTRUSTED candidate the native run validates (derived number AND root).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const READER_PATH = fileURLToPath(new URL('../reader/schedule_reader.mjs', import.meta.url));
export const READER_SHA256 = '688b7a1f09c898f66cc7b92473a9fbda042402ef833bb983ff794e5f07128fb0';     // reader/SHA256SUMS (frozen)
export function verifyReaderPin(p = READER_PATH) {
  const s = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  if (s !== READER_SHA256) throw Object.assign(new Error(`reader_pin: ${p} is not the frozen reader ${READER_SHA256.slice(0, 12)}`), { code: 'reader_pin' });
}
verifyReaderPin();
const R = await import(READER_PATH);

export const TRUSTED_KEYS = Object.freeze(['chainId', 'l1Head', 'l1HeadNumber', 'agreedL2OutputRoot', 'claimedL2OutputRoot',
  'claimedL2BlockNumber', 'rollupConfig', 'expectedRollupConfigHash', 'expectedScheduleId', 'intermediateBlockInterval']);   // r4 harness TRUSTED_KEYS
export const RESULT_FORMAT = 'enclave-base-derivation-result/v1';                                          // r4 harness RESULT_FORMAT
// CONTRACT_VARIANTS index -> upstream serde key (top-level, or under `base`)
export const SCHEDULE_KEYS = Object.freeze(['regolith_time', 'canyon_time', 'delta_time', 'ecotone_time', 'fjord_time', 'granite_time',
  'holocene_time', 'pectra_blob_schedule_time', 'isthmus_time', 'jovian_time', 'base.azul', 'base.beryl', 'base.cobalt', 'base.denim',
  'base.everest']);
const BASE_ALIASES = Object.freeze({ azul: 'v1', beryl: 'v2', cobalt: 'v3' });
const HASH = /^0x[0-9a-f]{64}$/;

export class Refused extends Error { constructor(code, m) { super(`${code}: ${m}`); this.code = code; } }
const refuse = (code, m) => { throw new Refused(code, m); };
const safeU64 = (x, what) => {
  const n = typeof x === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(x) ? BigInt(x) : typeof x === 'bigint' ? x : typeof x === 'number' && Number.isSafeInteger(x) ? BigInt(x) : null;
  if (n === null || n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) refuse('input', `${what} must be a safe non-negative integer`);
  return Number(n);
};

/** The node/host-served rollup config is an UNTRUSTED template (only deserialization shape matters for 8453): its l2_chain_id must be
 *  8453 and its 15 contract-backed activations are REPLACED by the authenticated schedule; alias spellings are removed. */
export function scheduleRollupConfig(template, accepted) {
  R.assertAccepted(accepted);
  if (!template || typeof template !== 'object' || Array.isArray(template)) refuse('rollup_config', 'template must be a JSON object');
  if (template.l2_chain_id !== R.CHAIN_ID) refuse('rollup_config', `template l2_chain_id must be ${R.CHAIN_ID}`);
  const c = structuredClone(template);
  if (c.base !== undefined && (typeof c.base !== 'object' || c.base === null || Array.isArray(c.base))) refuse('rollup_config', 'template base must be an object');
  c.base = { ...(c.base || {}) };
  for (const [canon, alias] of Object.entries(BASE_ALIASES)) delete c.base[alias];
  if (accepted.schedule.length !== SCHEDULE_KEYS.length) refuse('schedule', 'accepted schedule is not 15 entries');
  accepted.schedule.forEach((e, i) => {
    const [obj, key] = SCHEDULE_KEYS[i].startsWith('base.') ? [c.base, SCHEDULE_KEYS[i].slice(5)] : [c, SCHEDULE_KEYS[i]];
    if (e.timestamp === null) delete obj[key];                                       // contract 0 / no entry -> None (absent)
    else obj[key] = safeU64(e.timestamp, `schedule ${e.name}`);
  });
  if (Object.keys(c.base).length === 0) delete c.base;
  return c;
}

/** -> { trusted (exactly the 9 TRUSTED_KEYS, frozen), bytes (JSON), candidate } */
export function buildTrustedInput({ accepted, anchor, agreedL2OutputRoot, agreedL2BlockNumber, claim, rollupConfigTemplate, expectedRollupConfigHash,
                                    intermediateBlockInterval }) {
  R.assertAccepted(accepted);
  if (!anchor || anchor.hash !== accepted.l1.hash || String(anchor.number) !== accepted.l1.number)
    refuse('anchor', 'the caller anchor is not the L1 block the schedule was authenticated at');
  if (accepted.scheduleL2Block !== accepted.claimedL2Block)
    refuse('horizon', 'the native client injects no L2_SCHEDULE_BLOCK_NUMBER_KEY: the schedule horizon must be the claimed block');
  if (!HASH.test(agreedL2OutputRoot)) refuse('input', 'agreedL2OutputRoot must be 0x + 64 lowercase hex (caller-authorized)');
  if (!claim || !HASH.test(claim.l2OutputRoot)) refuse('input', 'claim.l2OutputRoot must be 0x + 64 lowercase hex');
  const claimNumber = safeU64(claim.l2BlockNumber, 'claim.l2BlockNumber');
  if (String(claimNumber) !== accepted.claimedL2Block) refuse('claim', 'the candidate claim number is not the block the schedule horizon was derived for');
  // r2: caller-authorized interval + agreed block number (never from the host witness); upstream sampler rules checked before any run
  if (intermediateBlockInterval === undefined || intermediateBlockInterval === null) refuse('interval', 'intermediateBlockInterval is required (caller-authorized)');
  if (typeof intermediateBlockInterval !== 'number' && typeof intermediateBlockInterval !== 'bigint') refuse('interval', 'intermediateBlockInterval must be an integer');
  const interval = (() => { try { return safeU64(intermediateBlockInterval, 'intermediateBlockInterval'); } catch { return refuse('interval', 'intermediateBlockInterval must be a safe integer'); } })();
  if (interval < 1) refuse('interval', 'intermediateBlockInterval must be non-zero (upstream ZeroIntermediateBlockInterval)');
  const agreedNumber = safeU64(agreedL2BlockNumber, 'agreedL2BlockNumber');
  if (claimNumber <= agreedNumber) refuse('interval', 'claimed block must be above the agreed block (upstream EmptyRange)');
  if ((claimNumber - agreedNumber) % interval !== 0) refuse('interval', `range ${claimNumber - agreedNumber} is not a multiple of the interval ${interval} (upstream PartialInterval)`);
  if (expectedRollupConfigHash !== R.CONFIG_HASH_PIN_CANDIDATE.value)
    refuse('config_hash', `expectedRollupConfigHash must be the source pin candidate ${R.CONFIG_HASH_PIN_CANDIDATE.value}`);
  const trusted = { chainId: R.CHAIN_ID, l1Head: accepted.l1.hash, l1HeadNumber: safeU64(accepted.l1.number, 'l1HeadNumber'),
    agreedL2OutputRoot, claimedL2OutputRoot: claim.l2OutputRoot, claimedL2BlockNumber: claimNumber,
    rollupConfig: scheduleRollupConfig(rollupConfigTemplate, accepted), expectedRollupConfigHash, expectedScheduleId: accepted.expectedScheduleId,
    intermediateBlockInterval: interval };
  if (JSON.stringify(Object.keys(trusted)) !== JSON.stringify(TRUSTED_KEYS)) refuse('internal', 'trusted keys drifted from r3');
  return { trusted: deepFreeze(trusted), bytes: Buffer.from(JSON.stringify(trusted)), bound: Object.freeze({ agreedL2BlockNumber: agreedNumber }),
           candidate: Object.freeze({ l2OutputRoot: claim.l2OutputRoot, l2BlockNumber: claimNumber, status: 'untrusted until the native run accepts it' }) };
}

/** The native harness's stdout JSON (exit 0) must bind EVERY trusted field; anything else (incl. a refusal) is refused here too.
 *  `input` is buildTrustedInput's return (trusted + the caller-bound agreed block number). */
export function acceptNativeResult(result, input) {
  const { trusted, bound } = input || {};
  if (!trusted || !bound) refuse('native', 'acceptNativeResult needs the buildTrustedInput result');
  if (!result || result.format !== RESULT_FORMAT || 'refused' in result) refuse('native', 'not an accepted native derivation result');
  const want = { chainId: trusted.chainId, l1Head: trusted.l1Head, l1HeadNumber: trusted.l1HeadNumber, agreedL2OutputRoot: trusted.agreedL2OutputRoot,
    l2OutputRoot: trusted.claimedL2OutputRoot, l2BlockNumber: trusted.claimedL2BlockNumber,
    rollupConfigHash: trusted.expectedRollupConfigHash, scheduleId: trusted.expectedScheduleId,
    intermediateBlockInterval: trusted.intermediateBlockInterval, l2PreBlockNumber: bound.agreedL2BlockNumber };
  const bad = Object.entries(want).filter(([k, v]) => result[k] !== v).map(([k]) => k);
  if (bad.length) refuse(bad.includes('rollupConfigHash') ? 'config_hash' : bad.includes('scheduleId') ? 'schedule' : 'native', `native result does not bind ${bad.join(', ')}`);
  const roots = typeof result.intermediateRoots === 'string' && /^0x([0-9a-f]{64})+$/.test(result.intermediateRoots) ? result.intermediateRoots.slice(2).match(/.{64}/g) : null;
  const expectCount = (trusted.claimedL2BlockNumber - bound.agreedL2BlockNumber) / trusted.intermediateBlockInterval;
  if (!roots || roots.length !== expectCount || '0x' + roots[roots.length - 1] !== trusted.claimedL2OutputRoot)
    refuse('native', `intermediateRoots must be ${expectCount} whole roots ending at the claimed root`);
  return Object.freeze({ verified: 'native-derivation-bound', l1: { hash: trusted.l1Head, number: trusted.l1HeadNumber },
    base: Object.freeze({ number: trusted.claimedL2BlockNumber, outputRoot: trusted.claimedL2OutputRoot }),
    notAProvider: 'Base header hash/stateRoot/timestamp unauthenticated here; no runtime binding (see report)' });
}
function deepFreeze(o) { Object.values(o).forEach((v) => typeof v === 'object' && v !== null && deepFreeze(v)); return Object.freeze(o); }
