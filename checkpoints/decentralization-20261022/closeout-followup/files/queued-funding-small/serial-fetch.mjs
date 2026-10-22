// serial-fetch.mjs: ONE request at a time per RPC origin, around the reviewed boundedFetch (response byte cap, its own
// deadline, redirect:'error'), so a QuorumChain peer never sends a concurrent burst (mainnet.base.org rejects them from this
// host; sequential requests pass). Requests run in arrival order. A failed request releases the next one. A request whose
// caller already gave up (aborted signal) is never started. There are no retries here; viem's retryCount stays 0. The
// QuorumChain itself is unchanged: the same 2-of-3, the same block and freshness rules. Only its peers' clients are injected.
export function serializeFetch(fetchFn) {
  let tail = Promise.resolve(), active = 0, maxActive = 0, started = 0;
  const f = (url, init = {}) => {
    const run = tail.then(() => {
      if (init.signal?.aborted) throw init.signal.reason ?? new Error("aborted before it was sent");
      active++; started++; if (active > maxActive) maxActive = active;
      return Promise.resolve().then(() => fetchFn(url, init)).finally(() => { active--; });
    });
    tail = run.then(() => {}, () => {});
    return run;
  };
  f.stats = () => ({ active, maxActive, started });
  return f;
}

/** QuorumChain peers whose transport is the reviewed boundedFetch, serialized per origin; viem http, no retries. */
export function serialPeers({ rpcs, createPublicClient, viemHttp, chain, boundedFetch, timeoutMs = 12000, inner }) {
  return rpcs.map((origin) => {
    const fetchFn = serializeFetch(boundedFetch({ timeoutMs, ...(inner ? { fetch: inner } : {}) }));
    return { origin, fetchFn, client: createPublicClient({ chain, transport: viemHttp(origin, { retryCount: 0, timeout: timeoutMs, fetchFn }) }) };
  });
}
