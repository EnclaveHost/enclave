// Durable cache/audit, not restored authority. Only this process's successfully
// validated native segments enter `verified`; the saved manifest never does.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { strictWriteFile } from '../lease-release-journal.mjs';
import { takeRuntimeLock } from '../runtime-lock.mjs';
import { validateAnchor } from './journal.mjs';
import { assertCheckedCoverage, validateLogQuery, COVERAGE_FORMAT, FILTER_ID, MAX_COVERAGE_BYTES } from './coverage.mjs';

export const MAX_HISTORY_BYTES = 4 * 1024 ** 3;
const MANIFEST_BYTES = 16 << 20, MAX_SEGMENTS = 16384;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[0-9a-f]{64}$/;
const int = n => Number.isSafeInteger(n) && n >= 0;
function regular(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw Error('invalid private coverage file');
  return stat.size;
}
function checkedFloor(old, anchor) {
  if (!old || anchor.base.number > old.base.number) {
    if (old && (anchor.l1.number < old.l1.number || anchor.l1.number === old.l1.number && anchor.l1.hash !== old.l1.hash))
      throw Error('coverage L1 floor rollback');
    return structuredClone(anchor);
  }
  if (anchor.base.number === old.base.number) {
    if (anchor.base.hash !== old.base.hash || anchor.l1.number < old.l1.number ||
        anchor.l1.number === old.l1.number && anchor.l1.hash !== old.l1.hash) throw Error('coverage floor contradiction');
    return structuredClone(anchor);
  }
  return old; // catch-up is private until both durable floors have been reached
}

export async function openCoverageStore(directory, { binding, initialize = false, maximumBytes = MAX_HISTORY_BYTES } = {}) {
  if (!path.isAbsolute(directory) || !HASH.test(binding || '') || !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 3 * MANIFEST_BYTES || maximumBytes > MAX_HISTORY_BYTES) throw Error('invalid coverage store bounds');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('coverage directory must be private');
  const file = path.join(directory, 'manifest.json'), unlock = await takeRuntimeLock(path.join(directory, 'coverage.lock'));
  let state, usedBytes = 0, failed = false, closed = false, pending = false;
  const verified = [];
  try {
    // Account for orphan chunks and interrupted chunk writes too. No automatic
    // eviction; the quota reserves two maximum manifests for atomic replacement.
    const dir = fs.opendirSync(directory); let count = 0;
    try {
      for (let entry; (entry = dir.readSync());) {
        if (++count > MAX_SEGMENTS * 2 + 4) throw Error('coverage directory entry limit');
        if (entry.name === 'coverage.lock') continue;
        if (['manifest.json', 'manifest.json.strict.tmp'].includes(entry.name)) { regular(path.join(directory, entry.name), MANIFEST_BYTES); continue; }
        if (!/^[0-9a-f]{64}\.json(?:\.strict\.tmp)?$/.test(entry.name)) throw Error('unexpected coverage file');
        usedBytes += regular(path.join(directory, entry.name), MAX_COVERAGE_BYTES);
      }
    } finally { dir.closeSync(); }
    if (usedBytes + 2 * MANIFEST_BYTES > maximumBytes) throw Error('coverage history budget exhausted');
    if (!fs.existsSync(file)) {
      if (!initialize || usedBytes) throw Error('coverage manifest missing; explicit enrollment/recovery required');
      state = { format: 'enclave-derived-coverage-journal/v1', binding, maximumBytes, floor: null, entries: [] };
      strictWriteFile(file, JSON.stringify(state));
    }
    regular(file, MANIFEST_BYTES); state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.format !== 'enclave-derived-coverage-journal/v1' || state.binding !== binding || state.maximumBytes !== maximumBytes ||
        !Array.isArray(state.entries) || state.entries.length > MAX_SEGMENTS) throw Error('coverage journal binding or schema mismatch');
    if (state.floor) validateAnchor(state.floor);
    let previous = '0'.repeat(64);
    for (const entry of state.entries) {
      const { hash, ...value } = entry;
      if (hash !== digest(JSON.stringify(value)) || entry.previousDigest !== previous || !HASH.test(entry.chunkHash) ||
          !int(entry.bytes) || entry.bytes > MAX_COVERAGE_BYTES || !int(entry.fromBlock) || !int(entry.toBlock) || entry.toBlock < entry.fromBlock ||
          entry.toBlock - entry.fromBlock >= 1800 || !/^0x[0-9a-f]{64}$/.test(entry.agreedRoot)) throw Error('coverage journal corruption');
      validateAnchor(entry.anchor);
      if (entry.anchor.base.number !== entry.toBlock || entry.anchor.tier !== 'l1-finalized-derived') throw Error('coverage journal anchor mismatch');
      previous = hash;
    }
  } catch (e) { unlock(); throw e; }
  const alive = () => { if (failed || closed) throw Error('coverage store closed or failed'); };
  const status = () => {
    alive(); if (pending) throw Error('coverage publication pending; recovery required');
    return { usedBytes, maximumBytes, reservedMetadataBytes: 2 * MANIFEST_BYTES,
      verifiedFromBlock: verified[0]?.fromBlock ?? null, verifiedToBlock: verified.at(-1)?.toBlock ?? null,
      savedFloor: structuredClone(state.floor) };
  };
  return Object.freeze({ status,
    // Persist first, return a one-shot publication callback. The provider calls
    // it only after its anchor journal succeeds (or during non-serving catch-up).
    stage(coverage, agreed, anchor) {
      alive(); assertCheckedCoverage(coverage); validateAnchor(agreed); validateAnchor(anchor);
      if (pending) throw Error('coverage publication already pending');
      if (coverage.fromBlock !== agreed.base.number + 1 || coverage.toBlock !== anchor.base.number || anchor.tier !== 'l1-finalized-derived')
        throw Error('coverage does not advance agreed anchor');
      const last = verified.at(-1);
      if (last && (coverage.fromBlock !== last.toBlock + 1 || agreed.base.hash !== last.anchor.base.hash || agreed.base.outputRoot !== last.anchor.base.outputRoot))
        throw Error('runtime coverage gap or predecessor mismatch');
      try {
        const bytes = JSON.stringify(coverage), size = Buffer.byteLength(bytes), chunkHash = digest(bytes), chunk = path.join(directory, `${chunkHash}.json`);
        if (size > MAX_COVERAGE_BYTES || state.entries.length >= MAX_SEGMENTS) throw Error('coverage history limit reached; no automatic eviction');
        const exists = fs.existsSync(chunk);
        if (!exists && usedBytes + size + 2 * MANIFEST_BYTES > maximumBytes) throw Error('coverage history budget exhausted; no automatic eviction');
        if (exists && (regular(chunk, MAX_COVERAGE_BYTES) !== size || digest(fs.readFileSync(chunk)) !== chunkHash)) throw Error('saved coverage chunk corrupted');
        const entry = { previousDigest: state.entries.at(-1)?.hash || '0'.repeat(64), chunkHash, bytes: size,
          fromBlock: coverage.fromBlock, toBlock: coverage.toBlock, agreedRoot: agreed.base.outputRoot, anchor: structuredClone(anchor) };
        const next = { ...state, floor: checkedFloor(state.floor, anchor), entries: [...state.entries, { ...entry, hash: digest(JSON.stringify(entry)) }] };
        const manifest = JSON.stringify(next);
        if (Buffer.byteLength(manifest) > MANIFEST_BYTES) throw Error('coverage manifest budget exhausted; no automatic eviction');
        if (!exists) { strictWriteFile(chunk, bytes); usedBytes += size; }
        strictWriteFile(file, manifest); state = next; pending = true;
        let published = false;
        return () => { alive(); if (published) throw Error('coverage publication already consumed');
          published = true; pending = false; verified.push(entry); };
      } catch (e) { failed = true; throw e; }
    },
    async read(query, anchor, { signal, maxBytes = MAX_COVERAGE_BYTES } = {}) {
      alive(); signal?.throwIfAborted();
      if (pending) throw Error('coverage publication pending; recovery required');
      if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_COVERAGE_BYTES) throw Error('invalid derived log response cap');
      const filter = validateLogQuery(query, anchor), first = verified[0], last = verified.at(-1);
      if (!first || filter.fromBlock < first.fromBlock || filter.toBlock > last.toBlock) throw Error('requested history is outside runtime-verified coverage');
      const result = { format: 'enclave-derived-logs/v1', logs: [], anchor: structuredClone(anchor), filter,
        coverage: { format: COVERAGE_FORMAT, filterId: FILTER_ID, fromBlock: filter.fromBlock, toBlock: filter.toBlock,
          complete: true, availableFromBlock: first.fromBlock, availableToBlock: last.toBlock } };
      let responseBytes = Buffer.byteLength(JSON.stringify(result)), cursor = filter.fromBlock;
      if (responseBytes > maxBytes) throw Error('derived log response too large; request a smaller complete block range');
      for (const entry of verified) {
        if (entry.toBlock < cursor) continue;
        if (cursor > filter.toBlock) break;
        if (entry.fromBlock > cursor) throw Error('runtime coverage gap');
        signal?.throwIfAborted(); alive();
        const chunk = path.join(directory, `${entry.chunkHash}.json`);
        try {
          if (regular(chunk, MAX_COVERAGE_BYTES) !== entry.bytes) throw Error('coverage chunk size changed');
          const raw = await fsp.readFile(chunk, { signal });
          if (raw.length !== entry.bytes || digest(raw) !== entry.chunkHash) throw Error('coverage chunk hash changed');
          const value = JSON.parse(raw);
          for (const log of value.logs) if (log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock &&
              log.address === filter.address && filter.topic0s.includes(log.topics[0]) && log.topics[1] === filter.topic1) {
            responseBytes += Buffer.byteLength(JSON.stringify(log)) + 1;
            if (responseBytes > maxBytes) throw Error('derived log response too large; request a smaller complete block range');
            result.logs.push(log);
          }
        } catch (e) {
          if (!signal?.aborted && !/response too large/.test(e.message)) failed = true;
          throw e;
        }
        cursor = Math.min(entry.toBlock, filter.toBlock) + 1;
        await yieldIO(); // allow cancellation/deadlines between bounded chunks
      }
      signal?.throwIfAborted(); alive();
      if (cursor !== filter.toBlock + 1) throw Error('runtime coverage incomplete');
      return result;
    },
    close() { if (!closed) { closed = true; verified.length = 0; unlock(); } },
  });
}
