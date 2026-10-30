// Authenticated, expiring per-app routes on the Enclave network (docs/design/enclave-network.md). This is DNS/control
// metadata; application bytes never pass through this service. The relay serves it at /v1/network/routes.
//
// Only signed v2 publications carrying the owner's current v5 network policy are accepted. Everything from the TUNA
// era is refused: v1 host allocation publications, and route policies v2 (guarded TUNA), v3 (on-chain direct) and
// v4 (USDC TUNA). Hosts publish v5 only since 2026-10-13.
import net from 'node:net';
import {verifyRoute,recordHash} from '../network/route-record.mjs';
import {validateNetworkPolicy} from '../network/network-policy.mjs';

export const RETIRED_PUBLICATION='TUNA route publications are retired: only signed per-app routes under an Enclave-network (v5) policy are accepted';

// Each accepted publication is also kept in `memory` (key p-<id>), so a restarted relay serves the routes it had
// instead of none until every host publishes again (a relay deploy took every app off DNS for ~25-60 s, 2026-10-14).
// A kept route is used only while it is still the latest one the anti-rollback record committed (same hash), and
// stays subject to its own expiry, the lease and the host's eligibility, exactly as before the restart.
const keptKey = id => 'p-' + id;
export function createNetworkRoutes({ operatorOf, endpointId, eligible, now = Date.now, leaseOf, memory, network, hostAdmission = null }) {
  const apps = new Map(), restored = new Set();
  async function restore(id) {
    if (!memory || apps.has(id) || restored.has(id)) return;
    restored.add(id);
    try {
      const kept = await memory.get(keptKey(id)), committed = await memory.get(id);
      if (kept?.record && kept.bundle?.record && committed?.hash && recordHash(kept.bundle.record) === committed.hash && !apps.has(id))
        apps.set(id, kept);
    } catch {}
  }
  return {
    async publish(publication) {
      if (publication?.version !== 2) throw new Error(RETIRED_PUBLICATION);
      if (publication.policy?.version !== 5) throw new Error(`${RETIRED_PUBLICATION} (policy version ${publication.policy?.version})`);
      if (!network) throw new Error('the Enclave network is not configured on this relay');
      if (!leaseOf || !memory) throw new Error('signed per-app routes are not configured');
      if (Buffer.byteLength(JSON.stringify(publication)) > 65536) throw new Error('route publication too large');
      const {endpoint, bundle} = publication, id = bundle?.record?.deploymentId;
      if (typeof endpoint !== 'string') throw new Error('invalid registered endpoint');
      const origin = new URL(endpoint);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || endpoint.endsWith('/')) throw new Error('invalid registered endpoint');
      if (!apps.has(id) && apps.size >= 4096) throw new Error('app publication limit');
      const policy = validateNetworkPolicy(publication.policy), lease = await leaseOf(id);
      if (policy.deploymentId !== id || !lease || String(await endpointId(endpoint)).toLowerCase() !== lease.runner) throw new Error('route is not from the deployment runner');
      // A chain-read lease already proved the runner's registry entry active for
      // this operator (endpoint -> runner checked above); others ask the registry.
      const operator = lease.runnerRegistered ? lease.runnerOperator : await operatorOf(endpoint);
      if (!operator || operator.toLowerCase() !== lease.runnerOperator.toLowerCase()) throw new Error('inactive route operator');
      // Only the owner's current network policy (or the default, when the owner never set one) may carry routes.
      if (recordHash(network.currentPolicy(id)) !== recordHash(policy)) throw new Error('route policy is not the owner\'s current network policy');
      const record = await verifyRoute(bundle, {deploymentId: id, policy, lease, memory, networkProviders: await network.eligible(), providerProbeSigners: network.checkers, hostAdmission, now: now()});
      if (publication.status) network.noteStatus(id, publication.status);
      const entry = {endpoint, bundle: structuredClone(bundle), record};
      apps.set(id, entry);
      await memory.update(keptKey(id), () => entry).catch(() => {});
    },
    async map(rows) {
      const labels = {}, deployments = {}, pending = [], seen = new Set(), duplicates = new Set();
      for (const d of rows) {
        if (!/^0x[0-9a-f]{64}$/i.test(d.id || '')) continue;
        const id = d.id.toLowerCase(), label = id.slice(2, 10);
        if (seen.has(label)) { duplicates.add(label); delete labels[label]; } seen.add(label);
        await restore(id);
        const route = apps.get(id), published = !!route || !!(memory && await memory.get(id));
        const admission = eligible(d);
        if (Number(d.leaseUntil) * 1000 <= now() || !admission || (typeof admission === 'number' && admission <= now())) continue;
        // an app that never published has no route: there is no shared fallback
        if (!published) { pending.push({id, reason: 'host_unpublished'}); continue; }
        const until = Math.min(route?.record.expiresAt || 0, Number(d.leaseUntil) * 1000, typeof admission === 'number' ? admission : Infinity);
        const current = route?.bundle.authorization.delegation.runner === String(d.runner).toLowerCase();
        const routes = current && until > now() ? route.record.routes : [];
        if (!routes.length) { pending.push({id, reason: 'private_routes_unavailable'}); continue; }
        const transport = routes[0].transport;
        deployments[id] = {transport, endpoint: route.endpoint, expiresAt: until, dedicatedIP: false,
          https: {address: routes[0].address, port: 443}, httpsRoutes: routes, discovery: {ipns: route.record.ipns}, version: 2};
        if (!duplicates.has(label)) {
          const addresses = routes.map(r => r.address);
          labels[label] = {transport, relay: transport === 'direct' ? 'direct' : 'enclave', expiresAt: until, addresses,
            ...(addresses.find(net.isIPv4) ? {a: addresses.find(net.isIPv4)} : {}), ...(addresses.find(net.isIPv6) ? {aaaa: addresses.find(net.isIPv6)} : {})};
        }
      }
      // `transport` names this map's format for its readers (relay/dns-relay.js, network/preflight.mjs); each deployment
      // and label says its own transport (enclave-network or direct).
      return {transport: 'enclave-network', updatedAt: new Date(now()).toISOString(), relays: [], labels, deployments, pending};
    },
  };
}
