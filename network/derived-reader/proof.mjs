import { keccak256, toBytes } from 'viem';
import { authenticateAnchor, headerHash } from './vendor/anchor-bootstrap.mjs';
import { runA1 } from './vendor/a1-anchor.mjs';
import { readSchedule, CONFIG_HASH_PIN_CANDIDATE } from './vendor/schedule_reader.mjs';
import { buildTrustedInput } from './vendor/schedule-input-r2.mjs';
import { assertL1Runtime } from './l1-runtime.mjs';
import { finalizedHeader } from './rpc.mjs';
import { validateCoverage } from './coverage.mjs';
export const keccak = bytes => toBytes(keccak256(bytes));
const HASH = /^0x[0-9a-f]{64}$/;

export async function authenticateBootstrap({ l1, execution, base, a1Config, signal, now = Date.now }) {
  assertL1Runtime(l1); signal?.throwIfAborted();
  const result = await runA1(a1Config, {
    helios: (method, params) => l1.request(method, params, { signal }),
    el: (method, params) => execution(method, params, { signal }),
  }, { keccak, headerHash, now });
  const number = Number(result.N);
  if (!Number.isSafeInteger(number) || number < 1) throw Error('invalid ASR bootstrap number');
  const header = await base('eth_getBlockByNumber', [`0x${number.toString(16)}`, false], { signal });
  const verified = authenticateAnchor({ rootClaim: result.outputRoot, l2BlockNumber: number }, header, keccak);
  const timestamp = Number(BigInt(header.timestamp));
  if (!Number.isSafeInteger(timestamp) || timestamp > Math.floor(now() / 1000) + 2) throw Error('invalid ASR block timestamp');
  signal?.throwIfAborted(); assertL1Runtime(l1);
  return Object.freeze({ tier: 'l1-finalized-asr-anchor',
    base: Object.freeze({ number, hash: verified.blockHash, stateRoot: verified.stateRoot,
      messagePasserStorageRoot: verified.messagePasserStorageRoot, outputRoot: result.outputRoot, timestamp }),
    l1: Object.freeze({ number: Number(result.l1.number), hash: result.l1.hash, stateRoot: result.l1.stateRoot, timestamp: Number(result.l1.timestamp) }) });
}
export async function prepareProof({ l1, l1Head, agreed, header, rollupConfigTemplate, intermediateBlockInterval, signal, now = Date.now }) {
  assertL1Runtime(l1);
  const number = Number(BigInt(header.number));
  if (!Number.isSafeInteger(number) || number <= agreed.base.number) throw Error('candidate does not advance agreed root');
  // This is an untrusted candidate root. Only the native derivation may accept it.
  const blockHash = headerHash(header, keccak, { requireIsthmus: true });
  if (header.hash !== blockHash) throw Error('candidate header hash mismatch');
  const root = keccak256(`0x${'0'.repeat(64)}${header.stateRoot.slice(2)}${header.withdrawalsRoot.slice(2)}${blockHash.slice(2)}`);
  const request = (method, params) => l1.request(method, params, { signal });
  const block = async tag => {
    const raw = await request('eth_getBlockByNumber', [tag, false]);
    // Historical anchor timestamps need not be near wall time here; the
    // selected l1Head was freshness-checked separately and must remain exact.
    const parsed = finalizedHeader(raw, Math.floor(now() / 1000), 3600);
    return { ...parsed, number: BigInt(parsed.number) };
  };
  const accepted = await readSchedule({ l1: {
    finalized: () => block('finalized'), blockByNumber: n => block(`0x${n.toString(16)}`),
    call: (to, data, n) => request('eth_call', [{ to, data }, `0x${n.toString(16)}`]),
  }, keccak, anchor: { hash: l1Head.hash, number: BigInt(l1Head.number) }, claimedL2Block: BigInt(number) });
  signal?.throwIfAborted();
  return buildTrustedInput({ accepted, anchor: l1Head, agreedL2OutputRoot: agreed.base.outputRoot, agreedL2BlockNumber: agreed.base.number,
    claim: { l2OutputRoot: root, l2BlockNumber: number }, rollupConfigTemplate,
    expectedRollupConfigHash: CONFIG_HASH_PIN_CANDIDATE.value, intermediateBlockInterval });
}
export function bindNativeV2(result, input, header, l1Head) {
  return bindNative(result, input, header, l1Head, 'enclave-base-derivation-result/v2');
}
export function bindNativeV3(result, input, header, l1Head) {
  const anchor = bindNative(result, input, header, l1Head, 'enclave-base-derivation-result/v3');
  return { anchor, coverage: validateCoverage(result, input, anchor) };
}
function bindNative(result, input, header, l1Head, format) {
  if (result?.format !== format || Object.hasOwn(result, 'refused')) throw Error(`combined native derivation ${format} result required`);
  const t = input.trusted;
  const fields = { chainId: 8453, l1Head: t.l1Head, l1HeadNumber: t.l1HeadNumber, agreedL2OutputRoot: t.agreedL2OutputRoot,
    l2PreBlockNumber: input.bound.agreedL2BlockNumber, l2BlockNumber: t.claimedL2BlockNumber, l2OutputRoot: t.claimedL2OutputRoot,
    rollupConfigHash: t.expectedRollupConfigHash, scheduleId: t.expectedScheduleId, intermediateBlockInterval: t.intermediateBlockInterval };
  for (const [key, value] of Object.entries(fields)) if (result[key] !== value) throw Error(`native result does not bind ${key}`);
  const count = (t.claimedL2BlockNumber - input.bound.agreedL2BlockNumber) / t.intermediateBlockInterval;
  if (!Number.isSafeInteger(count) || count < 1 || typeof result.intermediateRoots !== 'string' ||
      !/^0x([0-9a-f]{64})+$/.test(result.intermediateRoots) || result.intermediateRoots.length !== 2 + count * 64 ||
      `0x${result.intermediateRoots.slice(-64)}` !== t.claimedL2OutputRoot) throw Error('native intermediate roots do not bind the range');
  const bound = authenticateAnchor({ rootClaim: t.claimedL2OutputRoot, l2BlockNumber: t.claimedL2BlockNumber }, header, keccak);
  const base = { number: bound.number, hash: bound.blockHash, stateRoot: bound.stateRoot,
    messagePasserStorageRoot: bound.messagePasserStorageRoot, outputRoot: t.claimedL2OutputRoot, timestamp: Number(BigInt(header.timestamp)) };
  if (!Number.isSafeInteger(base.timestamp)) throw Error('native result timestamp overflow');
  for (const [key, value] of Object.entries(base)) if (result.base?.[key] !== value) throw Error(`native executed header differs at ${key}`);
  if (l1Head.hash !== t.l1Head || l1Head.number !== t.l1HeadNumber || !HASH.test(l1Head.stateRoot)) throw Error('native L1 context differs');
  return Object.freeze({ tier: 'l1-finalized-derived', base: Object.freeze(base), l1: Object.freeze({ ...l1Head }) });
}
