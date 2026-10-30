// Stateful, callable reader. Only a successful LOCAL native derivation may
// populate readAnchor(). ASR is a bootstrap and saved JSON is a rollback floor;
// neither is ever relabelled as a near-current derived result.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { openDerivedJournal, validateAnchor } from './journal.mjs';
import { READER_FILE, BRIDGE_FILE, proposedEnrollmentFloor, planEnrollment, derivedEnrollmentFloorDigest } from './enrollment.mjs';
export { derivedEnrollmentFloorDigest } from './enrollment.mjs';
import { stageBinary, reapRun } from './process.mjs';
import { startL1Runtime, assertL1Runtime, readCheckpoint } from './l1-runtime.mjs';
import { stageLibraries } from './libraries.mjs';
import { boundedRpc, finalizedHeader } from './rpc.mjs';
import { authenticateBootstrap, prepareProof, bindNativeV2, bindNativeV3 } from './proof.mjs';
import { invokeDerivation, DERIVATION_BUILDS, DERIVATION_V3_BUILDS } from './native.mjs';
import { openCoverageStore, MAX_HISTORY_BYTES } from './coverage-store.mjs';
import { MAX_COVERAGE_BYTES } from './coverage.mjs';
import { takeRuntimeLock } from '../runtime-lock.mjs';
import { strictWriteFile } from '../lease-release-journal.mjs';
import { commitJournalBytes, journalBytesDigest, validateJournalCommit } from '../journal-commit.mjs';
export const DERIVED_STATE_API = 'enclave-derived-state/v1';
export const BOOTSTRAP_POLICY = Object.freeze({ expectedChainId: 1, pinBy: 'hash',
  portal: '0x49048044d57e1c92a77f79988d21fa8faf74e97e', asr: '0x909f6cf47ed12f010a796527f562bfc26c7f4e72',
  portalAsrGetter: 'anchorStateRegistry()', maxFinalizedAgeSec: 1800 });

export async function createDerivedProvider({ l1, journal, executable, runtime = null, workDir, bootstrap, base,
  resultVersion = 2, coverageStore = null,
  maxBlocks = 1800, intermediateBlockInterval = 1, maxAnchorAgeSec = 1800, nativeTimeoutMs = 180000,
  maxWitnessBytes = 64 << 20, maxMemoryMiB = 1536, now = Date.now }) {
  assertL1Runtime(l1);
  if (![2, 3].includes(resultVersion) || resultVersion === 3 && (!coverageStore || intermediateBlockInterval !== 1) ||
      resultVersion === 2 && coverageStore) throw Error('v3 coverage needs explicit version, store, and interval one');
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 1800 ||
      !Number.isInteger(intermediateBlockInterval) || intermediateBlockInterval < 1 || intermediateBlockInterval > maxBlocks ||
      !Number.isInteger(maxAnchorAgeSec) || maxAnchorAgeSec < 20 || maxAnchorAgeSec > 3600 ||
      !Number.isInteger(maxWitnessBytes) || maxWitnessBytes < 1 || maxWitnessBytes > (128 << 20) ||
      !Number.isInteger(nativeTimeoutMs) || nativeTimeoutMs < 1 || nativeTimeoutMs > 3600000 ||
      !Number.isInteger(maxMemoryMiB) || maxMemoryMiB < 128 || maxMemoryMiB > 4096) throw Error('invalid derived reader policy bounds');
  let agreed = null, latest = null, pending = null, busy = false, closed = false, active = null, activeDone = Promise.resolve();
  const alive = () => {
    if (closed) throw Error('derived provider closed');
    journal.read(); // A failed/uncertain persistence operation fences even the previous in-memory anchor.
    coverageStore?.status();
    assertL1Runtime(l1);
  };
  const savedFloor = () => {
    const a = journal.read().floor, c = coverageStore?.status().savedFloor;
    if (a && c && a.base.number === c.base.number && a.base.hash !== c.base.hash) throw Error('anchor and coverage floors contradict');
    return !a || c && c.base.number > a.base.number ? c : a;
  };
  const consistentL1 = async (head, signal) => {
    const raw = await l1.request('eth_getBlockByNumber', [`0x${head.number.toString(16)}`, false], { signal });
    const checked = finalizedHeader(raw, Math.floor(now() / 1000), 3600);
    if (checked.hash !== head.hash || checked.stateRoot !== head.stateRoot || checked.timestamp !== head.timestamp) throw Error('L1 derivation input no longer matches the local light client');
  };
  async function exclusive(signal, run) {
    alive(); signal?.throwIfAborted();
    if (busy) throw Error('derived provider busy');
    busy = true; const controller = new AbortController(); active = controller;
    let finished; activeDone = new Promise(resolve => { finished = resolve; });
    const abort = () => controller.abort(signal.reason); signal?.addEventListener('abort', abort, { once: true });
    try { return await run(controller.signal); }
    finally { signal?.removeEventListener('abort', abort); busy = false; active = null; finished(); }
  }
  async function currentAnchor(signal) {
    if (!latest) throw Error('no locally derived anchor; bootstrap/catch-up is required');
    const value = latest, seconds = Math.floor(now() / 1000);
    if (seconds - value.base.timestamp > maxAnchorAgeSec || value.base.timestamp > seconds + 2) throw Error('derived Base anchor is stale');
    await consistentL1(value.l1, signal); signal?.throwIfAborted(); alive();
    if (Math.floor(now() / 1000) - value.base.timestamp > maxAnchorAgeSec) throw Error('derived Base anchor aged out while reading');
    return structuredClone(value);
  }
  return Object.freeze({
    // Public fields are proposed inputs for the untrusted witness builder.
    // The ticket's authoritative copy remains private to this process.
    async prepare({ blockNumber, rollupConfigTemplate, signal } = {}) {
      return exclusive(signal, async proofSignal => {
        if (pending && pending.expiresAt > now()) throw Error('one witness ticket is already outstanding');
        pending = null;
        if (!agreed) {
          const seed = validateAnchor(await bootstrap({ signal: proofSignal }));
          if (seed.tier !== 'l1-finalized-asr-anchor') throw Error('initial agreed root must be freshly ASR-authenticated');
          agreed = seed; // never load an agreed root from journal JSON
        }
        const floor = savedFloor();
        if (!Number.isSafeInteger(blockNumber) || blockNumber <= agreed.base.number || blockNumber - agreed.base.number > maxBlocks ||
            (blockNumber - agreed.base.number) % intermediateBlockInterval !== 0) throw Error('candidate range exceeds reader bounds');
        if (floor && agreed.base.number < floor.base.number && blockNumber > floor.base.number) throw Error('recovery must derive the saved floor exactly before passing it');
        const head = await l1.finalized({ signal: proofSignal });
        if (head.number < agreed.l1.number || head.number === agreed.l1.number && head.hash !== agreed.l1.hash) throw Error('L1 finalized authority regressed');
        const header = await base('eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false], { signal: proofSignal });
        if (!header || BigInt(header.number) !== BigInt(blockNumber)) throw Error('candidate source returned another block number');
        const input = await prepareProof({ l1, l1Head: head, agreed, header, rollupConfigTemplate, intermediateBlockInterval, signal: proofSignal, now });
        proofSignal.throwIfAborted(); alive();
        const token = randomBytes(32).toString('hex');
        pending = { token, input, header: structuredClone(header), head, expiresAt: now() + nativeTimeoutMs, agreed };
        return Object.freeze({ ticket: token, expiresAt: pending.expiresAt, trusted: structuredClone(input.trusted),
          agreedL2BlockNumber: agreed.base.number, maximumWitnessBytes: maxWitnessBytes });
      });
    },
    async submit({ ticket, witness, signal } = {}) {
      return exclusive(signal, async proofSignal => {
        if (!pending || ticket !== pending.token || pending.expiresAt <= now()) throw Error('unknown or expired native proof ticket');
        const proof = pending; pending = null; // one-shot; no concurrent replay
        const result = await invokeDerivation({ executable, runtime, trusted: proof.input.trusted, witness, workDir, signal: proofSignal,
          timeoutMs: Math.min(nativeTimeoutMs, proof.expiresAt - now()), maxWitnessBytes, maxMemoryMiB,
          outputBytes: resultVersion === 3 ? MAX_COVERAGE_BYTES : 65536 + Math.ceil((proof.input.trusted.claimedL2BlockNumber - proof.agreed.base.number) / intermediateBlockInterval) * 192 });
        const bound = resultVersion === 3 ? bindNativeV3(result, proof.input, proof.header, proof.head) : null;
        const accepted = bound?.anchor || bindNativeV2(result, proof.input, proof.header, proof.head);
        if (accepted.base.timestamp < proof.agreed.base.timestamp || accepted.base.timestamp > Math.floor(now() / 1000) + 2) throw Error('derived block timestamp regressed or is from the future');
        await consistentL1(proof.head, proofSignal); proofSignal.throwIfAborted(); alive();
        const floor = savedFloor();
        const publishCoverage = bound ? coverageStore.stage(bound.coverage, proof.agreed, accepted) : null;
        try {
          if (floor && accepted.base.number < floor.base.number) {
            publishCoverage?.();
            agreed = accepted;
            return { status: 'recovering', verifiedThrough: accepted.base.number, requiredFloor: floor.base.number };
          }
          // Both durable writes precede publication. A partially committed pair
          // fences this process; restart re-derives through the stricter floor.
          await journal.accept(proof.agreed, accepted, { signal: proofSignal });
          proofSignal.throwIfAborted();
          if (closed) throw Error('derived provider closed');
          await consistentL1(proof.head, proofSignal); proofSignal.throwIfAborted();
          if (closed) throw Error('derived provider closed');
          publishCoverage?.();
        } catch (e) { closed = true; latest = null; throw e; }
        agreed = accepted;
        // Catch-up can advance durable progress without publishing a serving
        // anchor. Replication latency must not turn an aged result into fresh authority.
        const age = Math.floor(now() / 1000) - accepted.base.timestamp;
        if (age > maxAnchorAgeSec || age < -2) {
          latest = null;
          return { status: 'recovering', verifiedThrough: accepted.base.number, reason: 'derived anchor outside freshness bound' };
        }
        latest = accepted;
        return { status: 'verified', anchor: structuredClone(accepted) };
      });
    },
    async readAnchor({ signal } = {}) {
      return exclusive(signal, currentAnchor);
    },
    async readDerivedLogs(query = {}) {
      return exclusive(query.signal, async proofSignal => {
        if (!coverageStore) throw Error('derived logs require the explicit v3 reader');
        const signal = AbortSignal.any([proofSignal, AbortSignal.timeout(30000)]);
        const anchor = await currentAnchor(signal);
        const result = await coverageStore.read(query, anchor, { signal });
        await currentAnchor(signal); // same exclusive snapshot, including freshness after disk IO
        return result;
      });
    },
    status() { return { busy, closed, hasDerivedAnchor: !!latest,
      baseAgeSec: latest ? Math.floor(now() / 1000) - latest.base.timestamp : null,
      // Freshness here is diagnostic; readAnchor additionally checks live L1 ownership/canonicality.
      withinBaseAgeBound: !!latest && Math.floor(now() / 1000) - latest.base.timestamp <= maxAnchorAgeSec,
      verifiedThrough: agreed?.base.number ?? null,
      hasPendingWitness: !!pending && pending.expiresAt > now(), savedFloor: savedFloor()?.base.number ?? null,
      resultVersion, coverage: coverageStore?.status() ?? null }; },
    async close() { closed = true; pending = null; latest = null; active?.abort(Error('derived provider closed')); await activeDone; },
  });
}

// Called INSIDE the accepted image/domain. Its measured release pins this code,
// L1 binary/checkpoint, native build and library closure. No host status endpoint
// or arbitrary local process is substituted for those components.
export function derivedReaderLayout(config) {
  const split = ['journalDir', 'coverageDir', 'runsDir'].some(k => config[k] !== undefined);
  if (split && config.stateDir !== undefined) throw Error('ambiguous legacy and split reader directories');
  const paths = split ? { journalDir: config.journalDir, coverageDir: config.coverageDir, runsDir: config.runsDir }
    : { journalDir: config.stateDir, coverageDir: path.join(config.stateDir || '', 'coverage'), runsDir: path.join(config.stateDir || '', 'runs') };
  if (Object.values(paths).some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw Error('absolute reader directories required');
  for (const key of Object.keys(paths)) paths[key] = path.resolve(paths[key]);
  if (split) for (const [i, a] of Object.values(paths).entries()) for (const b of Object.values(paths).slice(i + 1))
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw Error('split reader directories must be disjoint');
  return { ...paths, split };
}
function readerConfiguration(config, options) {
  const layout = derivedReaderLayout(config);
  const { native, l1: l1Config, a1Config = BOOTSTRAP_POLICY, baseUrl } = config;
  if (Object.entries(BOOTSTRAP_POLICY).some(([key, value]) => a1Config[key] !== value))
    throw Error('derived reader needs the reviewed ASR bootstrap policy');
  const resultVersion = native?.resultVersion ?? 2;
  if (![2, 3].includes(resultVersion) || resultVersion === 3 && (config.intermediateBlockInterval ?? 1) !== 1)
    throw Error('invalid native result version or coverage interval');
  const builds = options.acceptedDerivationBuilds || (resultVersion === 3 ? DERIVATION_V3_BUILDS : DERIVATION_BUILDS);
  if (!builds[native?.sha256]) throw Error('no qualified native derivation build configured');
  const checkpoint = readCheckpoint(l1Config.checkpointFile, { accepted: options.l1Options?.acceptedCheckpoints, now: options.now || Date.now });
  const binding = createHash('sha256').update(JSON.stringify({ chain: 8453, native: native.sha256,
    nativeRuntime: native.runtime?.build ?? null, l1Runtime: l1Config.runtime?.build ?? null,
    l1: l1Config.binary.sha256, checkpoint: checkpoint.digest, a1: a1Config, interval: config.intermediateBlockInterval ?? 1,
    ...(resultVersion === 3 ? { resultVersion, historyMaximumBytes: config.historyMaximumBytes ?? MAX_HISTORY_BYTES } : {}) })).digest('hex');
  return { ...layout, native, l1Config, a1Config, baseUrl, resultVersion, builds, binding };
}
function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw Error('reader state directories must be private and owned by the runtime user');
}
// This is the binding the admin signs; computing it does not start a reader or
// grant authority. Test-only build/checkpoint capabilities remain options, never JSON.
export const derivedReaderBinding = (config, options = {}) => readerConfiguration(config, options).binding;
// Explicit enrollment/rebind through an authenticated provider. Local records
// remain rollback restrictions. No mode promotes saved state to a chain proof.
export async function enrollDerivedState(config, { anchorJournal, verifyEnrollment, commit,
  enrollmentFloor = null, commitTimeoutMs = 10000, signal, ...options } = {}) {
  const { journalDir, coverageDir, runsDir, split, binding } = readerConfiguration(config, options);
  validateJournalCommit({ commit, requireCommit: true, commitTimeoutMs });
  if (!split || config.initializeState === true || typeof verifyEnrollment !== 'function' ||
      typeof anchorJournal !== 'string' || !path.isAbsolute(anchorJournal))
    throw Error('explicit split-state enrollment with a verified provider is required');
  anchorJournal = path.resolve(anchorJournal);
  const file = path.join(journalDir, 'derived-state.json'), marker = path.join(journalDir, '.enrollment-inflight');
  if (anchorJournal === file || path.dirname(anchorJournal) === journalDir ||
      [coverageDir, runsDir].some(p => anchorJournal === p || anchorJournal.startsWith(p + path.sep)))
    throw Error('anchor journal must be separate from reader, cache and run directories');
  for (const dir of [journalDir, path.dirname(anchorJournal)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); privateDirectory(dir);
  }
  if (fs.realpathSync(journalDir) !== journalDir || fs.realpathSync(path.dirname(anchorJournal)) !== path.dirname(anchorJournal))
    throw Error('enrollment paths must be canonical');
  const unlock = await takeRuntimeLock(path.join(journalDir, 'derived-state.lock'), { signal });
  let unlockAnchor, timer, onAbort;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    unlockAnchor = await takeRuntimeLock(`${anchorJournal}.lock`, { signal });
    if ([file, anchorJournal, marker].some(p => fs.existsSync(`${p}.strict.tmp`)))
      throw Error('uncertain local enrollment write; role must reconcile committed state');
    const names = { [READER_FILE]: file, [BRIDGE_FILE]: anchorJournal }, local = {};
    for (const [rel, target] of Object.entries(names)) {
      if (!fs.existsSync(target)) continue;
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw Error('invalid local enrollment journal');
      local[rel] = fs.readFileSync(target, 'utf8');
    }
    const floorDigest = derivedEnrollmentFloorDigest(proposedEnrollmentFloor(local, enrollmentFloor));
    const deadline = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason || Error('enrollment verification aborted'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(Error('enrollment verification timeout')), commitTimeoutMs);
    });
    const verified = await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return verifyEnrollment(Object.freeze({ binding, floorDigest, signal: controller.signal }));
      }), deadline,
    ]);
    clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort);
    signal?.throwIfAborted(); controller.signal.throwIfAborted();
    const { pendingBytes, finalBytes, anchorBytes, phase } = planEnrollment({ local, binding, verified, enrollmentFloor });
    const markerBytes = JSON.stringify({ binding, enrollmentDigest: verified.digest });
    if (fs.existsSync(marker)) {
      const stat = fs.lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || fs.readFileSync(marker, 'utf8') !== markerBytes)
        throw Error('foreign or corrupt enrollment marker');
    }
    // Timeout/false means OUTCOME UNKNOWN. Only the role's fresh committed scan
    // can reconcile it, never an assumption that the previous write was absent.
    strictWriteFile(marker, markerBytes);
    const persist = async (target, bytes) => {
      signal?.throwIfAborted(); controller.signal.throwIfAborted();
      strictWriteFile(target, bytes);
      await commitJournalBytes(commit, { file: target, bytes, signal: controller.signal }, commitTimeoutMs);
      signal?.throwIfAborted(); controller.signal.throwIfAborted();
    };
    if (phase < 1) await persist(file, pendingBytes);
    if (phase < 2) await persist(anchorJournal, anchorBytes);
    if (phase < 3) await persist(file, finalBytes);
    fs.unlinkSync(marker);
    const fd = fs.openSync(journalDir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { binding, enrollmentDigest: verified.digest, floorDigest };
  } finally {
    clearTimeout(timer); if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    controller.abort(); signal?.removeEventListener('abort', abort);
    unlockAnchor?.(); unlock();
  }
}
export async function startDerivedReader(config, options = {}) {
  const { journalDir, coverageDir, runsDir: runs, split, native, l1Config, a1Config, baseUrl, resultVersion, builds, binding } = readerConfiguration(config, options);
  const initializeState = config.initializeState ?? false;
  for (const dir of [journalDir, runs]) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); privateDirectory(dir); }
  const journal = await openDerivedJournal(journalDir, { binding, initialize: initializeState,
    commit: options.journalCommit, requireCommit: options.requireJournalCommit, commitTimeoutMs: options.commitTimeoutMs });
  let l1, provider, runDir, coverageStore, unlockRuns;
  try {
    unlockRuns = await takeRuntimeLock(path.join(runs, 'runs.lock'));
    if (resultVersion === 3) coverageStore = await openCoverageStore(coverageDir, {
      binding, initialize: split || initializeState, maximumBytes: config.historyMaximumBytes ?? MAX_HISTORY_BYTES });
    // Reap only task-owned saved child identities under this journal's lock.
    for (const name of fs.readdirSync(runs)) {
      if (name === 'runs.lock') continue;
      if (!/^run-[A-Za-z0-9]+$/.test(name)) throw Error('unexpected derived runtime directory');
      const old = path.join(runs, name);
      if (fs.lstatSync(old).isSymbolicLink() || !fs.statSync(old).isDirectory()) throw Error('invalid saved reader run directory');
      for (const role of ['l1', 'native']) {
        const roleDir = path.join(old, role);
        if (fs.existsSync(roleDir)) {
          if (fs.lstatSync(roleDir).isSymbolicLink()) throw Error('invalid saved reader role directory');
          const executable = fs.existsSync(path.join(roleDir, 'libraries')) ? path.join(roleDir, 'libraries', 'ld-linux-x86-64.so.2') : path.join(roleDir, 'executable');
          await reapRun(roleDir, { executable });
          if (role === 'native') for (const proof of fs.readdirSync(roleDir).filter(n => /^proof-[A-Za-z0-9]+$/.test(n))) {
            const proofDir = path.join(roleDir, proof);
            if (fs.lstatSync(proofDir).isSymbolicLink()) throw Error('invalid saved proof directory');
            await reapRun(proofDir, { executable });
          }
        }
      }
      fs.rmSync(old, { recursive: true, force: true });
    }
    runDir = fs.mkdtempSync(path.join(runs, 'run-')); fs.chmodSync(runDir, 0o700);
    const l1Dir = path.join(runDir, 'l1'), nativeDir = path.join(runDir, 'native');
    fs.mkdirSync(l1Dir, { mode: 0o700 }); fs.mkdirSync(nativeDir, { mode: 0o700 });
    const executable = await stageBinary(native.path, native.sha256, nativeDir, builds);
    const runtime = await stageLibraries(native.runtime, nativeDir);
    l1 = await startL1Runtime(l1Config, { ...(options.l1Options || {}),
      runDir: l1Dir, signal: options.signal, now: options.now || Date.now });
    const base = boundedRpc(baseUrl);
    const execution = boundedRpc(l1Config.executionUrl);
    provider = await createDerivedProvider({ l1, journal, executable, runtime, workDir: nativeDir, base, resultVersion, coverageStore,
      bootstrap: params => authenticateBootstrap({ l1, execution, base, a1Config, ...params, now: options.now || Date.now }),
      maxBlocks: config.maxBlocks, intermediateBlockInterval: config.intermediateBlockInterval, maxAnchorAgeSec: config.maxAnchorAgeSec,
      nativeTimeoutMs: config.nativeTimeoutMs, maxWitnessBytes: config.maxWitnessBytes, maxMemoryMiB: config.maxMemoryMiB, now: options.now || Date.now });
    return Object.freeze({ ...provider, async close() { await provider.close(); await l1.close(); coverageStore?.close(); await journal.close(); fs.rmSync(runDir, { recursive: true, force: true }); unlockRuns?.(); } });
  } catch (e) {
    await provider?.close(); await l1?.close(); coverageStore?.close(); await journal.close();
    if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
    unlockRuns?.();
    throw e;
  }
}
