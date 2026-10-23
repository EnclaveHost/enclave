// Chain answers a route publication waits on. Hosts publish each app every
// 10 s through a 5 s client deadline, and a public-RPC quorum read can take
// seconds, so a still-valid agreed answer is served at once and renewed in
// the background. Only a missing answer waits for the chain.
import {chainAuthorityFromEnv} from '../network/lease-reader.mjs';

// Two of these must agree on every lease and registry answer. Measured from nan
// 2026-10-04: mainnet.base.org and most free endpoints refuse a relay's rate.
export const DEFAULT_NETWORK_CHAIN_RPCS = 'https://base-rpc.publicnode.com,https://base.gateway.tenderly.co,https://base-public.nodies.app,https://base.drpc.org';
// The relay's network LeaseReader authority from its environment: the provider quorum (NETWORK_CHAIN_RPCS, else the
// default set above) unless ENCLAVE_CHAIN_AUTHORITY=verifier + ENCLAVE_CHAIN_VERIFIER name the local proof-backed
// verifier (loopback only, checked when the reader is built). Then no RPC list is passed, so no provider client exists
// and a verifier refusal can never fall back.
export function networkReaderOptions(env = process.env) {
  const a = chainAuthorityFromEnv(env);
  if (a.authority === 'verifier') return a;
  return {rpc: (env.NETWORK_CHAIN_RPCS || DEFAULT_NETWORK_CHAIN_RPCS).split(',').map(s => s.trim())};
}

// Leases from a LeaseReader: fresh for `freshMs`, then served until the
// reader's own block-age expiry while one shared snapshot renews every app.
export function createLeaseSource({reader, freshMs = 15000, maxIds = 256, now = Date.now}) {
  const ids = new Set();
  return async function leaseOf(id) {
    const cached = reader.get(id);
    if (cached && cached.blockTime + freshMs > now()) return cached;
    ids.add(id); if (ids.size > maxIds) ids.delete(ids.values().next().value);
    const refresh = reader.refresh([...ids]);
    if (cached) { refresh.catch(() => {}); return cached; }
    await refresh;
    const lease = reader.get(id); if (!lease) ids.delete(id); return lease;
  };
}

// WHO OWNS a registry id: fresh for `freshMs`, then served up to `staleMs`
// while one shared read renews it. A failed read keeps the old answer only
// until it ages out. With no usable answer (a tunnel attaching after a relay
// restart) the read is retried before it throws to the caller.
export function createRegistryOperator({reader, registry, freshMs = 15000, staleMs = 60000, retries = 2, retryMs = 1000, maxEntries = 1024, now = Date.now}) {
  const entries = new Map();
  return async function registryOperator(id) {
    const address = registry(); if (!address) return null;
    const key = address.toLowerCase() + ':' + id, hit = entries.get(key), t = now();
    const usable = hit?.at !== undefined && hit.at + staleMs > t;
    if (usable && hit.at + freshMs > t) return hit.op;
    if (hit?.pending) return usable ? hit.op : hit.pending;
    const read = async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await reader.registryEntries(address, [id]); }
        catch (e) { if (usable || attempt >= retries) throw e; await new Promise((r) => setTimeout(r, retryMs * (attempt + 1))); }
      }
    };
    const pending = read().then(([e]) => {
      const op = e.active && !/^0x0{40}$/i.test(e.operator) ? e.operator : null;
      entries.set(key, {at: now(), op}); return op;
    }, (err) => {
      const current = entries.get(key);
      if (current?.pending === pending) {
        if (current.at !== undefined) entries.set(key, {at: current.at, op: current.op}); else entries.delete(key);
      }
      throw err;
    });
    entries.set(key, {...(hit?.at !== undefined ? {at: hit.at, op: hit.op} : {}), pending});
    if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    if (usable) { pending.catch(() => {}); return hit.op; }
    return pending;
  };
}
