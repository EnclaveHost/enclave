// Which HOST answers each RPC origin of a browser network profile, for the profile generator (scripts/network/
// browser-profile.mjs --verify-chain). An Enclave host's public RPC (network/public-rpc.mjs) states its registry id in
// GET /health and in every answer (X-Enclave-Rpc-Host). Two origins that name the same host - two DNS names, an address and
// a name, two exits - are ONE vote of one host's node, never two independent nodes, and are refused here.
// A non-Enclave RPC states nothing: its identity stays unknown (and distinct origins remain NOT proof of distinct
// operators: network/rpc-identity.mjs). A host could also front another host's node; nothing here can see that.
const HASH = /^0x[0-9a-f]{64}$/;

/** -> [{ url, hostId: '0x..'|null, role: 'public-rpc'|null, error?: string }] (GET <origin>/health, bounded) */
export async function rpcHostIdentities(urls, { fetch = globalThis.fetch, timeoutMs = 8000 } = {}) {
  return Promise.all(urls.map(async (url) => {
    try {
      const r = await fetch(new URL('/health', url), { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => null);
      const id = String(j?.hostId || '').toLowerCase();
      return j?.role === 'public-rpc' && HASH.test(id) && String(r.headers.get('x-enclave-rpc-host') || '').toLowerCase() === id
        ? { url, hostId: id, role: 'public-rpc' } : { url, hostId: null, role: null };
    } catch (e) { return { url, hostId: null, role: null, error: String(e.message || e).slice(0, 120) }; }
  }));
}

/** Throws when two origins are the same Enclave host; -> the list unchanged otherwise. */
export function assertDistinctRpcHosts(ids) {
  const seen = new Map();
  for (const x of ids) {
    if (!x.hostId) continue;
    if (seen.has(x.hostId)) throw new Error(`${seen.get(x.hostId)} and ${x.url} are the same host (${x.hostId}): one host under several names is one vote, not two RPCs`);
    seen.set(x.hostId, x.url);
  }
  return ids;
}
