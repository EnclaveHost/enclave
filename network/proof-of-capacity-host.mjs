// A host's part in EnclaveProofOfCapacity, for both host platforms (supervisor.js and windows/node): the check one
// host runs against another, the answer the checked host gives, and the agent that keeps a host in standing.
//
// THE CHECK is measured work with an answer the checker can compute itself: a challenge names a seed, a number of
// rounds, an amount of memory and a number of LANES; each lane fills that memory from its own seed and mixes it for
// that many rounds (`capacityWork`), all lanes at once; the digest over the lanes is the answer. The checked host
// signs its answer with its proof key (the key the registry publishes for it and that signs its proofs of time), so
// the answer is that host's and nobody else's.
//
// HOW MUCH is asked follows what the host itself ADVERTISES AS FREE, in the capacity record its operator key signs
// (/v1/host/capacity, the one its customers' readers use): as many lanes as it says it has free vCPUs, each with its
// share of the memory it says is free (bounded, see CHECK_LIMITS). And the answer must come back in about the time ONE
// lane takes the checker: a host that advertises eight free vCPUs and has one runs the lanes one after another and is
// late by a factor no slack covers. So a pass says: this host did, now, while whatever else it runs kept running, as
// much parallel CPU and memory work as it tells the market it has free. It still says nothing about a GPU or about
// the app it serves by itself: `also` takes further checks of a host (below), and none is built in.
//
// A host answers a challenge only from a host the CONTRACT assigned to check it in the current epoch, signed by that
// host's proof key, and once per checker and epoch: nobody else can make it work.
import {createHash, randomBytes} from 'node:crypto';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {checkCapacityRecordShape, hostCapacityMessage, hostCapacityHash} from './host-capacity-record.mjs';
import {capacityDomain, dutyRound, standingRound, VERDICT} from './proof-of-capacity.mjs';

export const CAPACITY_CHECK_PATH = '/v1/host/capacity-check';
// one lane of the default work takes a current processor between one and two seconds: long against the grace, so that
// lanes run one after another are told from lanes run side by side (with slack 3: from about four advertised vCPUs up;
// a host that advertises two or three and has one is not caught by the clock)
export const CHECK_DEFAULTS = Object.freeze({rounds: 300000, memoryMiB: 64, timeoutMs: 60000,
  maxLanes: 16,       // the most lanes a checker asks for, whatever the host advertises (the checker computes them all too)
  slack: 3,           // the answer may take this many times what ONE lane takes the checker (slower processors, a busy moment)
  graceMs: 1500});    // plus this, for the request's way there and back and the signature
export const CHECK_LIMITS = Object.freeze({rounds: 2000000, memoryMiB: 256, lanes: 64, totalMiB: 4096});
const HEX32 = /^0x[0-9a-f]{64}$/;
const need = (ok, what) => { if (!ok) throw new Error(what); };

// (plain ABI JSON and injected signature recovery: no package import here, see proof-of-capacity.mjs)
const fn = (name, inputs, outputs = [], stateMutability = 'view') => ({type: 'function', name, stateMutability,
  inputs: inputs.map(([n, t]) => ({name: n, type: t})), outputs: outputs.map(([n, t]) => ({name: n, type: t}))});
export const POC_ABI = Object.freeze([
  fn('proofSchema', [], [['', 'uint256']]),
  fn('epochNow', [], [['', 'uint64']]),
  fn('seedOf', [['epoch', 'uint64']], [['', 'bytes32']]),
  fn('targetsOf', [['epoch', 'uint64'], ['checker', 'bytes32']], [['', 'bytes32[]']]),
  fn('checkersOf', [['epoch', 'uint64'], ['target', 'bytes32']], [['', 'bytes32[]']]),
  fn('verdictOf', [['epoch', 'uint64'], ['checker', 'bytes32'], ['target', 'bytes32']], [['', 'uint8']]),
  fn('standing', [['host', 'bytes32'], ['epoch', 'uint64']], [['ok', 'bool'], ['why', 'string']]),
  fn('touch', [], [['', 'bytes32']], 'nonpayable'),
  fn('report', [['epoch', 'uint64'], ['checker', 'bytes32'], ['target', 'bytes32'], ['verdict', 'uint8'], ['evidence', 'bytes32'], ['sig', 'bytes']], [], 'nonpayable'),
  fn('proveSelf', [['host', 'bytes32'], ['anchorBlock', 'uint64'], ['anchorHash', 'bytes32'], ['evidence', 'bytes32'], ['sig', 'bytes']], [], 'nonpayable'),
]);
/** The contract's views, from a viem public client. */
export function capacityReader(client, address) {
  const read = (functionName, args = []) => client.readContract({address, abi: POC_ABI, functionName, args});
  return {
    proofSchema: () => read('proofSchema'), epochNow: () => read('epochNow'), seedOf: e => read('seedOf', [BigInt(e)]),
    targetsOf: (e, h) => read('targetsOf', [BigInt(e), h]), checkersOf: (e, h) => read('checkersOf', [BigInt(e), h]),
    verdictOf: (e, c, t) => read('verdictOf', [BigInt(e), c, t]), standing: (h, e) => read('standing', [h, BigInt(e)]),
    // the parent of the latest block: always within the 256 the contract can look back
    anchor: async () => { const head = await client.getBlock({blockTag: 'latest'}); return client.getBlock({blockNumber: head.number - 1n}); },
  };
}

/**
 * The work. Deterministic in (seed, rounds, memoryMiB); -> the digest as 0x + 64 hex.
 * It runs in slices of about a millisecond with the event loop let in between: a host answers checks from the process
 * that also carries its apps' connections, and a quarter second of hashing in one piece would hold every one of them.
 */
export async function capacityWork({seed, rounds, memoryMiB}) {
  const breathe = () => new Promise(r => setImmediate(r));
  need(HEX32.test(String(seed)), 'seed: 32 bytes');
  need(Number.isInteger(rounds) && rounds >= 1 && rounds <= CHECK_LIMITS.rounds, 'rounds');
  need(Number.isInteger(memoryMiB) && memoryMiB >= 1 && memoryMiB <= CHECK_LIMITS.memoryMiB, 'memoryMiB');
  const MiB = 1 << 20, size = memoryMiB * MiB, buf = Buffer.allocUnsafe(size), s = Buffer.from(seed.slice(2), 'hex');
  const index = Buffer.alloc(4);
  for (let i = 0; i < memoryMiB; i++) {            // every MiB filled from the seed and its own number
    index.writeUInt32BE(i); const block = createHash('sha256').update(s).update(index).digest();
    for (let o = i * MiB, end = o + MiB; o < end; o += 32) block.copy(buf, o);
    if (i % 4 === 3) await breathe();
  }
  let state = createHash('sha256').update(s).digest();
  for (let r = 0; r < rounds; r++) {               // each round reads 4 KiB where the state points and writes the new state back
    const at = (state.readUInt32BE(0) * 4096) % (size - 4096);
    state = createHash('sha256').update(state).update(buf.subarray(at, at + 4096)).digest();
    state.copy(buf, (state.readUInt32BE(4) * 32) % (size - 32));
    if (r % 128 === 127) await breathe();
  }
  return '0x' + state.toString('hex');
}

/**
 * The same work in `lanes` lanes at once, each on its own seed and its own `memoryMiB`: -> the digest over the lanes'
 * digests, in order. More than one lane runs in worker threads (this file is the worker), so the lanes really run side
 * by side when there are processors for them; a platform without worker threads runs them one after another, which
 * gives the same digest and, for a host being checked, a late answer.
 */
export async function capacityLanes({seed, rounds, memoryMiB, lanes}) {
  need(Number.isInteger(lanes) && lanes >= 1 && lanes <= CHECK_LIMITS.lanes && lanes * memoryMiB <= CHECK_LIMITS.totalMiB, 'lanes');
  const laneSeed = i => '0x' + createHash('sha256').update(Buffer.from(seed.slice(2), 'hex')).update(Buffer.from([i >> 8, i & 255])).digest('hex');
  const one = i => ({seed: laneSeed(i), rounds, memoryMiB});
  let digests;
  if (lanes === 1) digests = [await capacityWork(one(0))];
  else {
    const inThread = input => new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), {workerData: {capacityLane: input}});
      w.once('message', resolve); w.once('error', reject); w.once('exit', code => { if (code) reject(new Error('capacity lane ended ' + code)); });
    });
    try { digests = await Promise.all(Array.from({length: lanes}, (_, i) => inThread(one(i)))); }
    catch { digests = []; for (let i = 0; i < lanes; i++) digests.push(await capacityWork(one(i))); }
  }
  const h = createHash('sha256'); for (const d of digests) h.update(Buffer.from(d.slice(2), 'hex'));
  return '0x' + h.digest('hex');
}

const CHALLENGE = [{name: 'epoch', type: 'uint64'}, {name: 'checker', type: 'bytes32'}, {name: 'target', type: 'bytes32'},
  {name: 'seed', type: 'bytes32'}, {name: 'nonce', type: 'bytes32'}, {name: 'rounds', type: 'uint32'}, {name: 'memoryMiB', type: 'uint32'},
  {name: 'lanes', type: 'uint32'}];
const ANSWER = [{name: 'epoch', type: 'uint64'}, {name: 'checker', type: 'bytes32'}, {name: 'target', type: 'bytes32'},
  {name: 'nonce', type: 'bytes32'}, {name: 'digest', type: 'bytes32'}];
export const challengeMessage = (domain, c) => ({domain: capacityDomain(domain), types: {CapacityChallenge: CHALLENGE}, primaryType: 'CapacityChallenge',
  message: {epoch: BigInt(c.epoch), checker: c.checker, target: c.target, seed: c.seed, nonce: c.nonce, rounds: c.rounds, memoryMiB: c.memoryMiB, lanes: c.lanes}});
export const answerMessage = (domain, a) => ({domain: capacityDomain(domain), types: {CapacityAnswer: ANSWER}, primaryType: 'CapacityAnswer',
  message: {epoch: BigInt(a.epoch), checker: a.checker, target: a.target, nonce: a.nonce, digest: a.digest}});
// the seed the work runs on: the challenge's nonce under the epoch's seed, so no answer can be prepared before it is asked
const workSeed = c => '0x' + createHash('sha256').update(Buffer.from(c.seed.slice(2) + c.nonce.slice(2), 'hex')).digest('hex');
const validChallenge = c => c && typeof c === 'object' && c.version === 2 && Number.isSafeInteger(c.epoch) && c.epoch >= 0 &&
  [c.checker, c.target, c.seed, c.nonce].every(v => HEX32.test(String(v))) && c.checker !== c.target &&
  Number.isInteger(c.rounds) && c.rounds >= 1 && c.rounds <= CHECK_LIMITS.rounds &&
  Number.isInteger(c.memoryMiB) && c.memoryMiB >= 1 && c.memoryMiB <= CHECK_LIMITS.memoryMiB &&
  Number.isInteger(c.lanes) && c.lanes >= 1 && c.lanes <= CHECK_LIMITS.lanes && c.lanes * c.memoryMiB <= CHECK_LIMITS.totalMiB && typeof c.signature === 'string';

/**
 * The checked host's side: POST CAPACITY_CHECK_PATH. -> answer(body) -> {status, body}
 *   hostId, domain; reader (the contract's views); proofKeyOf(hostId) -> address | null (the registry's);
 *   sign(typedData) by this host's proof key; recover(typedData, signature) -> the signer's address (viem's
 *   recoverTypedDataAddress, handed in); work = capacityLanes (replaceable in tests)
 * Answers only the current epoch's seed, only a checker the contract assigned to this host, only over that checker's
 * signature, one challenge at a time and one per checker and epoch.
 */
export function createCapacityResponder({hostId, domain, reader, proofKeyOf, sign, recover, work = capacityLanes}) {
  need(HEX32.test(String(hostId)) && typeof recover === 'function', 'host id and signature recovery');
  const answered = new Map();   // "<epoch>:<checker>" -> the answer given (the same challenge again gets the same answer)
  let busy = false;
  const no = (status, error) => ({status, body: {error}});
  return async function answer(c) {
    if (!validChallenge(c)) return no(400, 'not a capacity challenge');
    if (c.target !== hostId) return no(404, 'another host');
    const epoch = Number(await reader.epochNow());
    if (c.epoch !== epoch || (await reader.seedOf(epoch)) !== c.seed) return no(409, 'not this epoch');
    if (!(await reader.checkersOf(epoch, hostId)).includes(c.checker)) return no(403, 'not assigned to check this host');
    const key = await proofKeyOf(c.checker);
    let signer = null; try { signer = await recover(challengeMessage(domain, c), c.signature); } catch {}
    if (!key || !signer || signer.toLowerCase() !== String(key).toLowerCase()) return no(403, 'not signed by the checker\'s proof key');
    const k = `${epoch}:${c.checker}`, before = answered.get(k);
    if (before) return before.nonce === c.nonce ? {status: 200, body: before.body} : no(429, 'already checked by this host in this epoch');
    if (busy) return no(503, 'busy with another check');
    busy = true;
    try {
      const digest = await work({seed: workSeed(c), rounds: c.rounds, memoryMiB: c.memoryMiB, lanes: c.lanes});
      const a = {version: 2, epoch, checker: c.checker, target: hostId, nonce: c.nonce, digest};
      const body = {...a, signature: await sign(answerMessage(domain, a))};
      for (const old of answered.keys()) if (!old.startsWith(epoch + ':')) answered.delete(old);
      answered.set(k, {nonce: c.nonce, body});
      return {status: 200, body};
    } finally { busy = false; }
  };
}

/**
 * What a host advertises as free, from the capacity record its operator key signs: for `claimOf` below.
 *   fetch; recoverMessage(message, signature) -> the signer's address (viem's recoverMessageAddress, handed in);
 *   chainId and registry the record must be for
 * -> claimOf(target, row) -> {lanes, freeMiB, record: <the record's hash>} | {none: why}
 * The record must be the target's own (its hostId, its registered endpoint), signed by its registry operator, current,
 * and for this chain and registry: a claim it did not sign, or signed for somewhere else, is no claim.
 */
export function createClaimReader({fetch = globalThis.fetch, recoverMessage, chainId, registry, timeoutMs = 8000, now = Date.now}) {
  need(typeof recoverMessage === 'function', 'message signature recovery');
  return async function claimOf(target, row) {
    try {
      const res = await fetch(String(row.endpoint).replace(/\/+$/, '') + '/v1/host/capacity', {redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
      if (!res.ok) return {none: `its capacity record answered HTTP ${res.status}`};
      const env = await res.json(), {record, availability: a} = checkCapacityRecordShape(env?.record, now());
      if (record.hostId !== target || record.endpoint !== row.endpoint) return {none: 'the record is another host\'s'};
      if (record.chainId !== chainId || record.registry !== String(registry).toLowerCase()) return {none: 'the record is for another chain or registry'};
      const signer = String(await recoverMessage(hostCapacityMessage(record), env.signature)).toLowerCase();
      if (signer !== record.operator || signer !== String(row.operator || '').toLowerCase()) return {none: 'the record is not signed by the host\'s registry operator'};
      const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
      const share = num(a.cpuShareFree) ?? 0;
      const vcpus = num(a.vcpusFree) ?? (num(a.nodeVcpus) !== null ? share * a.nodeVcpus : 0);
      const ramGb = num(a.ramGbFree) ?? (num(a.nodeRamGb) !== null ? share * a.nodeRamGb : 0);
      return {lanes: Math.floor(vcpus), freeMiB: Math.floor(ramGb * 1024), record: '0x' + hostCapacityHash(record)};
    } catch (e) { return {none: String(e?.message || e).slice(0, 120)}; }
  };
}

/**
 * The checker's side, as `check` for dutyRound: one challenge to `target`, judged. -> {verdict, evidence}
 *   host (the checker's id), domain, sign (its proof key); targetOf(id) -> {endpoint, proofKey, operator} | null (the
 *   registry's row); fetch; reachable() -> false when THIS host cannot reach the outside (then it throws: a verdict
 *   must be something the checker saw, not something it could not do)
 *   claimOf(target, row) -> {lanes, freeMiB, record} | {none: why}: what the target advertises as free
 *   (createClaimReader). A host with no claim the checker can verify is asked for ONE lane, and the record says so.
 *   rounds, memoryMiB: one lane's work (each lane gets memoryMiB, or its share of the free memory if that is less);
 *   maxLanes, slack, graceMs, timeoutMs: see CHECK_DEFAULTS
 *   also: [async (target, row, ctx) -> {name, ok, why, evidence?} | null]: further checks of a host that passed the work
 *   (the app it serves, a card it sells); one that says ok === false makes the verdict a fail, one that throws is no
 *   verdict this round. None is built in.
 * unreachable: no row, no answer, or an answer that is not an answer (HTTP error, not JSON) inside the deadline.
 * fail: an answer with the wrong digest, the wrong fields or another key's signature; one that took longer than
 *   slack x one lane on the checker + graceMs (the lanes did not run side by side: the capacity advertised is not
 *   there); a further check that failed.
 */
export function createCapacityChecker({host, domain, sign, recover, targetOf, fetch = globalThis.fetch, rounds = CHECK_DEFAULTS.rounds,
  memoryMiB = CHECK_DEFAULTS.memoryMiB, timeoutMs = CHECK_DEFAULTS.timeoutMs, maxLanes = CHECK_DEFAULTS.maxLanes, slack = CHECK_DEFAULTS.slack,
  graceMs = CHECK_DEFAULTS.graceMs, claimOf = null, also = [], reachable = async () => true, work = capacityLanes, now = Date.now}) {
  need(typeof recover === 'function', 'signature recovery');
  return async function check(target, {epoch, seed}) {
    let asked = {rounds, memoryMiB, lanes: 1};
    const record = (verdict, why, extra = {}) => ({verdict, evidence: JSON.stringify({kind: 'enclave-capacity-check/2', epoch, checker: host, target, ...asked, verdict, why, ...extra})});
    const row = await targetOf(target);
    if (!row?.endpoint || !row.proofKey) return record('unreachable', 'the registry has no endpoint or proof key for it');
    // how much: what the host itself says it has free
    const claim = claimOf ? await claimOf(target, row) : {none: 'no claim reader on this checker'};
    const lanes = claim.none ? 1 : Math.max(1, Math.min(maxLanes, claim.lanes));
    const laneMiB = claim.none ? memoryMiB : Math.max(1, Math.min(memoryMiB, Math.floor(claim.freeMiB / lanes)));
    asked = {rounds, memoryMiB: laneMiB, lanes, claim: claim.none ? {none: claim.none} : {lanes: claim.lanes, freeMiB: claim.freeMiB, record: claim.record}};
    const c = {version: 2, epoch, checker: host, target, seed, nonce: '0x' + randomBytes(32).toString('hex'), rounds, memoryMiB: laneMiB, lanes};
    c.signature = await sign(challengeMessage(domain, c));
    // before the clock starts: what one lane takes THIS host (the measure of the deadline), then the answer itself
    const t0 = now(); await work({seed: workSeed(c), rounds, memoryMiB: laneMiB, lanes: 1}); const oneLaneMs = Math.max(1, now() - t0);
    const expected = await work({seed: workSeed(c), rounds, memoryMiB: laneMiB, lanes});
    const allowMs = Math.min(timeoutMs, Math.ceil(slack * oneLaneMs + graceMs));
    const started = now();
    let res, body;
    try {
      res = await fetch(String(row.endpoint).replace(/\/+$/, '') + CAPACITY_CHECK_PATH, {method: 'POST', redirect: 'error',
        headers: {'content-type': 'application/json'}, body: JSON.stringify(c), signal: AbortSignal.timeout(timeoutMs)});
      body = res.ok ? await res.json() : null;
    } catch (e) {
      if (!(await reachable())) throw new Error('this host cannot reach the outside: no verdict');
      return record('unreachable', String(e?.name === 'TimeoutError' ? 'no answer inside the deadline' : e?.message || e).slice(0, 120));
    }
    const elapsedMs = now() - started, timing = {elapsedMs, oneLaneMs, allowMs};
    if (!res.ok) {
      // a host that is up and says "not this epoch" / "busy" has not been checked: no verdict this round
      if ([409, 429, 503].includes(res.status)) throw new Error(`the host answered ${res.status}: try again`);
      return record('unreachable', `HTTP ${res.status}`);
    }
    if (!body || body.version !== 2 || body.epoch !== epoch || body.checker !== host || body.target !== target || body.nonce !== c.nonce ||
        !HEX32.test(String(body.digest)) || typeof body.signature !== 'string') return record('fail', 'the answer is not for this challenge');
    let signer = null; try { signer = await recover(answerMessage(domain, body), body.signature); } catch {}
    if (!signer || signer.toLowerCase() !== String(row.proofKey).toLowerCase()) return record('fail', 'the answer is not signed by the host\'s proof key');
    if (body.digest !== expected) return record('fail', 'wrong digest', timing);
    if (elapsedMs > allowMs) return record('fail', lanes > 1
      ? `${lanes} lanes took ${elapsedMs} ms where one takes this checker ${oneLaneMs} ms: the capacity it advertises as free was not there`
      : 'too late', timing);
    const more = [];
    for (const extra of also) {
      const r = await extra(target, row, {epoch, seed});
      if (!r) continue;
      more.push({name: r.name, ok: r.ok === true, why: r.why || '', ...(r.evidence ? {evidence: r.evidence} : {})});
      if (r.ok !== true) return record('fail', `${r.name}: ${r.why || 'failed'}`, {...timing, also: more});
    }
    return record('pass', 'the digest is the checker\'s own, in time', {...timing, digest: body.digest, signature: body.signature, ...(more.length ? {also: more} : {})});
  };
}

/**
 * Keeps one host in standing. tick() does, in order, what the contract says is missing:
 *   - the epoch's seed, when no transaction has fixed it yet and this host has something to be paid for (`wantsCredit`)
 *   - this host's duty: a check of every host it was assigned and has not reported on, one `report` each
 *   - this host's own proof of capacity, only when `standing` says that is what is missing
 * send(functionName, args) submits a transaction to the contract (the host's own queue and key); a send that fails is
 * logged and tried again on the next tick, and never stops the rest of the round.
 * -> {epoch, reported: n, skipped: [...], selfProved: bool, standing: {ok, why}}
 */
export function createCapacityAgent({host, domain, reader, sign, send, check, selfCheck, wantsCredit = async () => true, log = () => {}}) {
  need(HEX32.test(String(host)), 'host id');
  let running = null;
  async function round() {
    const out = {epoch: Number(await reader.epochNow()), reported: 0, skipped: [], selfProved: false, standing: null};
    const attempt = async (what, fn) => { try { await fn(); return true; } catch (e) { log(`proof of capacity: ${what}: ${String(e?.shortMessage || e?.message || e).slice(0, 160)}`); return false; } };
    if (/^0x0+$/.test(String(await reader.seedOf(out.epoch))) && await wantsCredit())
      await attempt('seed', () => send('touch', []));
    const duty = await dutyRound({domain, host, reader, sign, check});
    out.skipped = duty.skipped;
    for (const r of duty.reports)
      if (await attempt(`report on ${r.target.slice(0, 10)}`, () => send('report', [BigInt(r.epoch), r.checker, r.target, r.verdict, r.evidence, r.signature]))) out.reported++;
    for (const s of duty.skipped) log(`proof of capacity: no verdict on ${s.target.slice(0, 10)}: ${s.why}`);
    if (await wantsCredit()) {
      const st = await standingRound({domain, host, reader, sign, selfCheck});
      out.standing = {ok: st.ok, why: st.why || ''};
      if (st.self) out.selfProved = await attempt('own proof', () => send('proveSelf', [st.self.host, st.self.anchorBlock, st.self.anchorHash, st.self.evidence, st.self.signature]));
      else if (!st.ok) log(`proof of capacity: not in standing for epoch ${st.epoch}: ${st.why}`);
    }
    return out;
  }
  return {tick() { return running || (running = round().finally(() => { running = null; })); }};
}

/** A host's own capacity record for a self-proof: the same work, on itself, under the epoch's seed. */
export const selfCapacityRecord = (host, {rounds = CHECK_DEFAULTS.rounds, memoryMiB = CHECK_DEFAULTS.memoryMiB, work = capacityWork, now = Date.now} = {}) =>
  async ({epoch, seed}) => {
    const started = now(), digest = await work({seed, rounds, memoryMiB});
    return JSON.stringify({kind: 'enclave-capacity-self/1', epoch, host, rounds, memoryMiB, digest, elapsedMs: now() - started});
  };
export {VERDICT};

// this file as a worker thread: one lane of capacityLanes
if (!isMainThread && workerData?.capacityLane) parentPort.postMessage(await capacityWork(workerData.capacityLane));
