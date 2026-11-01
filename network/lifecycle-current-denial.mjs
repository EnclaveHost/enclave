// Opt-in current-state denial capability. The caller supplies a qualified
// finalized baseline; this reader supplies no positive owner, policy or budget.
// The verifier is a trusted proof-executing capability, NOT a JSON authority
// label. Raw ancestry transport is untrusted and authenticated backwards from
// the verifier's current head. No production verifier or route is selected here.
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { hexToBytes, keccak256 } from 'viem';
import { verifierEndpoint, verifiedHeader, pinnedClient } from './verified-chain.mjs';
import { authenticateAncestors } from './derived-reader/vendor/anchor-bootstrap.mjs';
import { createLifecycleChainAdapter } from './deployment-chain-adapter.mjs';
import { certificateWitnessesHash, verifyGenerationChain } from './deployment-generation-certificate.mjs';
import { validateHostAuthorityContext, HOST_AUTHORITY_PROFILE } from './deployment-host-authority.mjs';

const HASH = /^0x[0-9a-f]{64}$/;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const freeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
const kc = b => hexToBytes(keccak256(b));
const noReceipts = () => { throw Error('current denial reader does not resolve transactions'); };

function baselineOf(input, pins) {
  // Do not allow an asynchronous caller to replace the baseline while reading.
  const x = structuredClone(input), { deployment, anchor: a, baseline: s, certificates } = x;
  if (!HASH.test(deployment || '') || s?.id !== deployment || s.thisHost !== pins.host || s.profile !== HOST_AUTHORITY_PROFILE ||
      s.verified !== true || s.proofVerified !== true || s.authorityTier !== 'l1-finalized-derived' ||
      a?.proofVerified !== true || a.tier !== s.authorityTier || a.hash !== s.blockHash || a.number !== s.blockNumber ||
      !integer(a.number) || !HASH.test(a.hash || '') || a.timestamp * 1000 !== s.blockAt ||
      a.ownerAuthority !== s.ownerAuthority || a.policyHash !== certificateWitnessesHash(s.policy) ||
      a.balanceWei !== s.budget?.balanceWei || a.enabled !== s.enabled || a.funded !== s.funded ||
      a.admitted !== s.enabled || a.fundedUntil !== s.fundedUntil ||
      a.hostAdmission?.host !== pins.host || a.hostAdmission.admitted !== s.admitted ||
      !Array.isArray(certificates) || certificates.length > 128)
    throw Error('current denial check needs the exact finalized deployment baseline');
  const aa = a.assignment, sa = s.assignment;
  if (aa?.deployment !== deployment || !sa || ['generation', 'state', 'host', 'operator', 'changedAt', 'failures', 'crashHeld']
    .some(k => aa[k] !== sa[k]) || aa.startAfter * 1000 !== sa.startAfter || sa.revision !== s.policy.revision)
    throw Error('current denial check baseline assignment differs from anchor');
  const e = s.hostAuthorityEvidence, c = validateHostAuthorityContext(e?.context);
  if (e.proofVerified !== true || e.blockHash !== a.hash || e.blockNumber !== String(a.number) ||
      c.hostId !== pins.host || c.chainId !== String(pins.chainId) || c.registry !== pins.contracts.registry.address.toLowerCase() ||
      c.registryCodeHash !== pins.contracts.registry.codeHash)
    throw Error('current denial check baseline host evidence is not bound to the anchor');
  return freeze(x);
}

export function createLifecycleCurrentDenialReader({ pins: suppliedPins, verifier, headers, hostPolicy, journalOwner,
  deadlineMs = 15000, maxHeaders = 2048, now = Date.now } = {}) {
  const pins = freeze(structuredClone(suppliedPins));
  if (pins?.chainId !== 8453 || pins.profile !== HOST_AUTHORITY_PROFILE || typeof headers?.header !== 'function' ||
      typeof journalOwner?.journal?.readAnchor !== 'function' || typeof journalOwner?.onRelease !== 'function' ||
      typeof hostPolicy?.load !== 'function' || typeof now !== 'function' ||
      !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 20000 ||
      !Number.isInteger(maxHeaders) || maxHeaders < 1 || maxHeaders > 2048)
    throw Error('owned current denial reader needs exact host-registry pins and bounded verifier/header/policy capabilities');
  const endpoint = verifierEndpoint(verifier);
  let active = null, stopped = false, closing = null, floor = null;
  const checkOwner = () => journalOwner.journal.readAnchor(pins.chainId);

  const authority = { kind: 'verified-head', async snapshot(read) {
    const op = active;
    if (!op || op.snapshotUsed) throw Error('current denial snapshot is private and one-shot');
    op.snapshotUsed = true;
    const { alive, request } = op;
    if (BigInt(await request('eth_chainId', [])) !== BigInt(pins.chainId)) throw Error('current verifier on another chain');
    const b = BigInt(await request('eth_blockNumber', []));
    if (b < 0n || b > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('current head number outside supported range');
    const tag = `0x${b.toString(16)}`;
    const h = verifiedHeader(await request('eth_getBlockByNumber', [tag, false]), b);
    const fresh = () => {
      const at = now();
      if (!integer(at) || h.timestamp > at + 2000 || h.timestamp + 20000 <= at || op.observedAt + 20000 <= at)
        throw Error('current denial observation expired or future');
    };
    fresh();
    if (floor && (b < floor.number || b === floor.number && h.hash !== floor.hash)) throw Error('current head rollback or contradiction');
    const value = await read(pinnedClient({ b, hash: h.hash, request, chainId: pins.chainId, alive }), b, h);
    const again = verifiedHeader(await request('eth_getBlockByNumber', [tag, false]), b);
    if (!isDeepStrictEqual(again, h)) throw Error('current head changed during proof read');
    fresh(); alive(); op.header = h; op.fresh = fresh;
    return { blockNumber: b, blockHash: h.hash, timestamp: h.timestamp, observedAt: op.observedAt, value,
      evidence: { tier: 'unsafe', proofVerified: true } };
  } };
  // Reuse every maintained code, ABI, closure, owner-policy and schema check.
  // This adapter never qualifies positive authority and is not exposed.
  const adapter = createLifecycleChainAdapter({ pins, authority, receipts: { locate: noReceipts, header: noReceipts, block: noReceipts },
    hostPolicy: { load: async (...args) => { active.alive(); const v = await hostPolicy.load(...args); active.alive(); return v; } }, now });

  async function read(input) {
    if (stopped) throw Error('current denial reader closed');
    if (active) throw Error('current denial reader busy');
    checkOwner();
    const x = baselineOf(input, pins), { deployment, anchor, baseline, certificates } = x;
    const ac = new AbortController(), endAt = performance.now() + deadlineMs;
    let revoked = false, timer, cancel;
    const cancellation = new Promise((_, reject) => { cancel = reject; });
    const op = { observedAt: now(), snapshotUsed: false, alive() {
      if (revoked || stopped || performance.now() >= endAt) throw Error('current denial read closed or expired');
      checkOwner(); return Math.max(1, Math.floor(endAt - performance.now()));
    }, stop() { revoked = true; ac.abort(); cancel(Error('current denial reader closed')); } };
    op.request = async (method, params) => {
      const v = await endpoint.request(method, params, op.alive(), ac.signal); op.alive(); return v;
    };
    active = op;
    const work = (async () => {
      const current = await adapter.read(deployment); op.alive();
      if (current.hostAuthority?.policyKnown !== true) throw Error('current host policy unknown; no denial decision');
      const h = op.header, top = Number(h.number);
      if (top < anchor.number || top - anchor.number + 1 > maxHeaders) throw Error('current head ancestry outside reviewed bound');
      const chain = [];
      for (let n = anchor.number; n <= top; n++) {
        const header = await headers.header(n, { signal: ac.signal, timeoutMs: op.alive() }); op.alive(); chain.push(header);
      }
      const ancestry = authenticateAncestors(chain, { number: top, blockHash: h.hash }, kc);
      if (ancestry.get(anchor.number)?.hash !== anchor.hash || ancestry.get(top)?.stateRoot !== h.stateRoot)
        throw Error('current head does not descend from finalized anchor at the proof root');
      let head = { proofVerified: true, tier: 'unsafe', number: top, hash: h.hash, timestamp: h.timestamp / 1000,
        observedAt: Math.floor(op.observedAt / 1000), anchorHash: anchor.hash, ancestryVerified: true, denied: false };
      const context = { pins: { chainId: pins.chainId, lifecycle: pins.contracts.lifecycle.address }, anchor, head,
        policy: baseline.policy, nowSec: Math.floor(now() / 1000) };
      const final = await verifyGenerationChain(certificates, context); op.alive();
      const reasons = [];
      // Current facts may reduce authority. They never replace the finalized
      // owner, policy, immutable content/resources, paid horizon or budget.
      for (const key of ['ownerAuthority', 'policy', 'appRef', 'resources', 'content', 'envelope', 'forPrivate', 'hostAuthority'])
        if (!isDeepStrictEqual(current[key], baseline[key])) reasons.push(`${key} changed`);
      // Schema3 retirement is metadata only; do not introduce a global veto.
      if (current.enabled !== true || current.admitted !== true || current.funded !== true || current.adminChanged !== false ||
          current.emergency?.pending !== false) reasons.push('current deployment or host refused');
      if (current.host.operator.toLowerCase() !== baseline.host.operator.toLowerCase() ||
          current.host.measurement !== baseline.host.measurement || current.host.rateWei !== baseline.host.rateWei)
        reasons.push('host operator, measurement or rate changed');
      const e = current.hostAuthorityEvidence, bc = baseline.hostAuthorityEvidence.context;
      if (!e || e.blockHash !== h.hash || e.blockNumber !== String(top)) throw Error('current host evidence not at authenticated head');
      validateHostAuthorityContext(e.context);
      if (e.status !== 'online' || e.context.digest !== bc.digest) reasons.push('current canonical host authority differs or is not Online');
      if (BigInt(current.budget.balanceWei) < final.assignment.remainingWei ||
          BigInt(current.budget.maxGasPrice) < BigInt(baseline.budget.maxGasPrice) || current.fundedUntil < final.assignment.fundedUntil)
        reasons.push('current budget or paid horizon reduced');
      // A submitted certificate chain may be ahead of the chain receipt. The
      // current chain may match an exact certified prefix, never an unrelated
      // generation or a new assignment learned only from an unsafe head.
      const n = current.assignment.generation - anchor.assignment.generation;
      if (!integer(n) || n > certificates.length) reasons.push('uncertified current generation');
      else {
        const expected = n === certificates.length ? final.assignment :
          (await verifyGenerationChain(certificates.slice(0, n), context)).assignment;
        const ca = current.assignment;
        if (ca.revision !== baseline.policy.revision || ['generation', 'state', 'host', 'operator', 'failures', 'crashHeld']
          .some(k => String(ca[k]).toLowerCase() !== String(expected[k]).toLowerCase()) ||
          ca.lastIntent !== (n === 0 ? baseline.assignment.lastIntent : certificates[n - 1].record.transitionIntent))
          reasons.push('current assignment differs from certified prefix');
        if (n === 0 && (ca.changedAt !== expected.changedAt || ca.startAfter !== expected.startAfter * 1000) ||
            ca.startAfter > expected.startAfter * 1000) reasons.push('current assignment timing differs from certified authority');
      }
      const again = verifiedHeader(await op.request('eth_getBlockByNumber', [`0x${h.number.toString(16)}`, false]), h.number);
      if (!isDeepStrictEqual(again, h)) throw Error('current head changed before denial publication');
      op.fresh(); op.alive();
      head = { ...head, denied: reasons.length > 0, reasons,
        currentHostAuthority: { ...e, proofVerified: true } };
      floor = { number: h.number, hash: h.hash };
      return freeze(head);
    })();
    op.drained = work.then(() => {}, () => {}).then(() => { if (active === op) active = null; });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { revoked = true; ac.abort(); reject(Error('current denial deadline')); }, deadlineMs); });
    try { return await Promise.race([work, timeout, cancellation]); }
    finally { revoked = true; clearTimeout(timer); ac.abort(); }
  }
  function close() {
    if (!closing) { stopped = true; const op = active; op?.stop(); closing = op?.drained ?? Promise.resolve(); }
    return closing;
  }
  checkOwner();
  journalOwner.onRelease(close); // register BEFORE publishing; raw drain retains ownership
  return Object.freeze({ read, close });
}
