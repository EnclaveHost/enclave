// Join an IN-DOMAIN authenticated derivation anchor to the existing local
// proof-executing client. readAnchor must be the qualified derivation/L1-light-
// client implementation, not a JSON status endpoint or an RPC block-tag read.
// No implementation is selected automatically. Without it this adapter refuses.
import { performance } from 'node:perf_hooks';
import { verifierEndpoint, verifiedHeader, pinnedClient } from './verified-chain.mjs';
const HASH = /^0x[0-9a-f]{64}$/;
const integer = n => Number.isSafeInteger(n) && n >= 0;

export function createLifecycleFinalitySnapshot({ readAnchor, verifier, chainId = 8453,
  maxAnchorAgeSec = 3600, deadlineMs = 200000, now = Date.now, journal } = {}) {
  if (typeof readAnchor !== 'function') throw Error('qualified in-domain finality reader is required');
  if (typeof journal?.readAnchor !== 'function' || typeof journal?.acceptAnchor !== 'function') throw Error('durable anchor journal is required');
  if (chainId !== 8453 || !Number.isInteger(maxAnchorAgeSec) || maxAnchorAgeSec < 20 || maxAnchorAgeSec > 3600 ||
      !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 200000) throw Error('invalid finality bridge bounds');
  const endpoint = verifierEndpoint(verifier);
  let busy = false;
  return async function snapshot(read) {
    if (typeof read !== 'function') throw Error('snapshot callback required');
    if (busy) throw Error('finality snapshot busy');
    busy = true;
    const ac = new AbortController(), deadline = performance.now() + deadlineMs;
    let closed = false, timer;
    const alive = () => { if (closed || performance.now() >= deadline) throw Error('finality snapshot closed or expired'); return Math.max(1, Math.floor(deadline - performance.now())); };
    const request = async (method, params) => {
      const result = await endpoint.request(method, params, Math.min(60000, alive()), ac.signal); alive(); return result;
    };
    const work = (async () => {
      const anchor = await readAnchor({ signal: ac.signal }); alive();
      const b = anchor?.base, l1 = anchor?.l1;
      if (anchor?.tier !== 'l1-finalized-derived' || !b || !integer(b.number) || !integer(b.timestamp) ||
          ![b.hash, b.stateRoot, b.outputRoot].every(x => HASH.test(x || '')) ||
          !l1 || !integer(l1.number) || !integer(l1.timestamp) || !HASH.test(l1.hash || ''))
        throw Error('authenticated derivation anchor required; ASR and RPC labels are insufficient');
      const fresh = () => {
        const seconds = Math.floor(now() / 1000);
        if (b.timestamp > seconds + 2 || l1.timestamp > seconds + 2 || seconds - b.timestamp > maxAnchorAgeSec)
          throw Error('derivation policy anchor outside configured age bound');
      };
      fresh();
      const floor = journal.readAnchor(chainId);
      if (floor && [ ['base', b], ['l1', l1] ].some(([k, block]) =>
        block.number < floor[k].number || block.number === floor[k].number && block.hash !== floor[k].hash))
        throw Error('derived anchor rollback or contradiction');
      if (Number(BigInt(await request('eth_chainId', []))) !== chainId) throw Error('verifier on another chain');
      const number = BigInt(b.number), tag = `0x${number.toString(16)}`;
      async function match() {
        const h = verifiedHeader(await request('eth_getBlockByNumber', [tag, false]), number);
        if (h.hash !== b.hash || h.stateRoot !== b.stateRoot || h.timestamp !== b.timestamp * 1000)
          throw Error('local proof root does not match authenticated derived anchor');
        return h;
      }
      const header = await match();
      const client = pinnedClient({ b: number, hash: b.hash, request, chainId, alive });
      const value = await read(client, number, header); alive();
      await match(); fresh(); alive();
      // Persist synchronously, with rollback checking, before publishing.
      journal.acceptAnchor(chainId, { base: b, l1, tier: anchor.tier }); alive();
      return { blockNumber: number, blockHash: b.hash, stateRoot: b.stateRoot,
        timestamp: b.timestamp * 1000, observedAt: now(), value,
        evidence: { authority: 'consumer-domain-derivation', tier: anchor.tier, proofVerified: true,
          base: { ...b }, l1: { ...l1 }, verifier: endpoint.label } };
    })();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(Error('finality snapshot deadline')); }, deadlineMs); });
    try { return await Promise.race([work, timeout]); }
    finally { closed = true; busy = false; clearTimeout(timer); ac.abort(); work.catch(() => {}); }
  };
}
