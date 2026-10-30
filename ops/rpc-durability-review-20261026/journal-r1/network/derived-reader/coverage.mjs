// Native v3 protocol validation. Only the pinned native execution path calls
// this; passing JSON here is not a remote proof or a grant of reader authority.
import { keccak256 } from 'viem';
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX = /^0x(?:[0-9a-f]{2})*$/;
export const COVERAGE_FORMAT = 'enclave-lease16-coverage/v1';
export const FILTER_ID = 'lease16-events/v1';
export const LEASE_TOPICS = Object.freeze([
  '0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0',
  '0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e',
  '0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882',
]);
export const MAX_COVERAGE_BYTES = 16 << 20;
const uint = n => Number.isSafeInteger(n) && n >= 0;
const CHECKED = new WeakSet();
export function assertCheckedCoverage(value) {
  if (!CHECKED.has(value)) throw Error('coverage must come from this process native result validation');
}

export function validateCoverage(result, input, anchor) {
  const c = result?.coverage, t = input?.trusted, from = input?.bound?.agreedL2BlockNumber + 1;
  if (result?.format !== 'enclave-base-derivation-result/v3' || !c || c.format !== COVERAGE_FORMAT || c.filterId !== FILTER_ID ||
      t?.intermediateBlockInterval !== 1 || c.fromBlock !== from || c.toBlock !== anchor.base.number ||
      !uint(from) || c.toBlock < from || c.toBlock - from >= 1800 ||
      !Array.isArray(c.blocks) || c.blocks.length !== c.toBlock - from + 1 || !Array.isArray(c.logs))
    throw Error('native complete lease coverage required');
  if (Buffer.byteLength(JSON.stringify(c)) > MAX_COVERAGE_BYTES) throw Error('native lease coverage exceeds byte limit');
  const blocks = new Map();
  let previousTime = -1;
  for (let i = 0; i < c.blocks.length; i++) {
    const b = c.blocks[i], sampled = `0x${result.intermediateRoots.slice(2 + i * 64, 2 + (i + 1) * 64)}`;
    if (!b || b.number !== from + i || !uint(b.timestamp) || b.timestamp < previousTime ||
        !['hash', 'stateRoot', 'messagePasserStorageRoot', 'outputRoot', 'receiptsRoot', 'transactionsRoot'].every(k => HASH.test(b[k])) ||
        b.outputRoot !== sampled || b.outputRoot !== keccak256(`0x${'0'.repeat(64)}${b.stateRoot.slice(2)}${b.messagePasserStorageRoot.slice(2)}${b.hash.slice(2)}`))
      throw Error('native coverage block does not bind its sampled output root');
    previousTime = b.timestamp; blocks.set(b.number, b);
  }
  const last = c.blocks.at(-1);
  for (const key of ['number','hash','stateRoot','messagePasserStorageRoot','outputRoot','timestamp'])
    if (last[key] !== anchor.base[key]) throw Error('native coverage does not end at accepted anchor');
  let previousBlock = -1, previousIndex = -1;
  for (const log of c.logs) {
    const b = blocks.get(log?.blockNumber);
    if (!b || !ADDRESS.test(log.address) || log.blockHash !== b.hash || !uint(log.logIndex) || !HASH.test(log.txHash) ||
        !HEX.test(log.data) || !Array.isArray(log.topics) || log.topics.length < 1 || log.topics.length > 4 ||
        !log.topics.every(v => HASH.test(v)) || !LEASE_TOPICS.includes(log.topics[0]) ||
        log.blockNumber < previousBlock || log.blockNumber === previousBlock && log.logIndex <= previousIndex)
      throw Error('native coverage log is malformed, duplicated, or out of order');
    previousBlock = log.blockNumber; previousIndex = log.logIndex;
  }
  // Completeness and receipt/transaction/header binding are assertions of the
  // pinned v3 executable. Hashing host-selected logs would not establish either.
  const copy = structuredClone(c);
  const freeze = o => { for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v); return Object.freeze(o); };
  freeze(copy); CHECKED.add(copy); return copy;
}

export function validateLogQuery(query, anchor) {
  const { address, topic0s, topic1, fromBlock, toBlock, anchor: requested } = query || {};
  if (!ADDRESS.test(address) || !Array.isArray(topic0s) || !topic0s.length || topic0s.length > LEASE_TOPICS.length ||
      new Set(topic0s).size !== topic0s.length || !topic0s.every(t => LEASE_TOPICS.includes(t)) || !HASH.test(topic1) ||
      !uint(fromBlock) || !uint(toBlock) || fromBlock > toBlock || toBlock > anchor.base.number ||
      requested?.number !== anchor.base.number || requested?.hash !== anchor.base.hash)
    throw Error('derived logs require an exact current snapshot anchor and bounded filter');
  return { address, topic0s: [...topic0s], topic1, fromBlock, toBlock };
}
