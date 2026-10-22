// The host's PUBLIC SERVICE roles on the Enclave network (work/host-service-transport-20261021): directory replica,
// bootstrap replica and policy mirror (and route-dns's DNS 53) reached by the public through WireGuard providers that
// forward raw packets only. One guarded 'service' circuit per exit provider the operator names (the providers whose
// addresses the service names resolve to): the exit grants exactly this host's derived names (host-service-names.mjs) and
// routes them by SNI/Host to this circuit; the host-service worker maps each to its loopback role port. Same shape as
// WgControlTransport (start(), reconcile(), close()).
//
// config (cfg.enclaveNetwork.hostServices): { zone, exits: [providerId, ...] (1-8),
//   ports: { "directory-replica": 18188, "bootstrap-replica": 18189, "policy-mirror": 18190 } (any subset, loopback),
//   tls?: { httpPort, tlsPorts: { <role>: port } }     (G3, the host's service-tls role, work/host-service-tls-20261021:
//                                                        port 80 of every derived name goes to its front httpPort -
//                                                        ACME http-01 plus raw passthrough - and 443 to tlsPorts[role];
//                                                        a role without a TLS port is closed on 443),
//   dns?: { tcp: 18153, udp: 18153 } }                 (route-dns; the exit forwards 53 only if its operator pins this host)
import tls from 'node:tls';
import { hostServiceNames, HOST_SERVICE_ROLES, validServiceZone } from './host-service-names.mjs';
const ZERO = '0x' + '0'.repeat(64), COOLDOWN_MAX_MS = 30 * 60000;
const port = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;

export function validateHostServicesTransport(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('hostServices must be an object');
  for (const k of Object.keys(c)) if (!['zone', 'exits', 'ports', 'tls', 'dns'].includes(k)) throw new Error(`hostServices: unknown field ${JSON.stringify(k)}`);
  validServiceZone(c.zone);
  if (!Array.isArray(c.exits) || c.exits.length < 1 || c.exits.length > 8 || c.exits.some((x) => typeof x !== 'string' || !/^[0-9a-f]{16,64}$/.test(x))) throw new Error('hostServices.exits: 1 to 8 provider ids');
  const roles = Object.keys(HOST_SERVICE_ROLES);
  if (!c.ports || typeof c.ports !== 'object' || !Object.keys(c.ports).length || Object.entries(c.ports).some(([r, p]) => !roles.includes(r) || !port(p))) throw new Error(`hostServices.ports: loopback ports of ${roles.join(', ')}`);
  if (c.tls !== undefined) {
    const t = c.tls, ok = t && typeof t === 'object' && !Object.keys(t).some((k) => !['httpPort', 'tlsPorts'].includes(k)) && port(t.httpPort) &&
      t.tlsPorts && typeof t.tlsPorts === 'object' && Object.keys(t.tlsPorts).length && Object.entries(t.tlsPorts).every(([r, p]) => c.ports[r] && port(p));
    if (!ok) throw new Error('hostServices.tls: { httpPort, tlsPorts: { <served role>: port } }');
    const all = [...Object.values(c.ports), t.httpPort, ...Object.values(t.tlsPorts)];
    if (new Set(all).size !== all.length) throw new Error('hostServices.tls: the front and TLS ports must differ from each other and from the role ports');
  }
  if (c.dns !== undefined && (!c.dns || typeof c.dns !== 'object' || Object.keys(c.dns).some((k) => !['tcp', 'udp'].includes(k)) || !port(c.dns.tcp) || !port(c.dns.udp))) throw new Error('hostServices.dns: {tcp, udp} loopback ports of route-dns');
  return { zone: c.zone, exits: [...new Set(c.exits)], ports: { ...c.ports }, tls: c.tls ? { httpPort: c.tls.httpPort, tlsPorts: { ...c.tls.tlsPorts } } : null,
    dns: c.dns ? { tcp: c.dns.tcp, udp: c.dns.udp } : null };
}

/** a verified TLS handshake to the host's own G3 listener (loopback), or false */
export function tlsReady({ port, servername, roots, timeoutMs = 3000, host = '127.0.0.1' }) {
  return new Promise((resolve) => {
    let done = false; const end = (v, s) => { if (done) return; done = true; s?.destroy(); resolve(v); };
    const s = tls.connect({ host, port, servername, rejectUnauthorized: true, ...(roots ? { ca: roots } : {}), ALPNProtocols: ['http/1.1'] },
      () => end(s.authorized === true, s));
    s.on('error', () => end(false, s)); s.setTimeout(timeoutMs, () => end(false, s));
  });
}

export class HostServiceTransport {
  // runtime: WgCircuitRuntime (with serviceWorkerModule); providers(): verified provider records (eligibleRoles,
  // qualifiedUntil); grants: WgGrants (revoke); hostId: this host's registry id (the runner)
  constructor({ runtime, providers, grants, hostId, config, now = Date.now, log = () => {} }) {
    const c = validateHostServicesTransport(config);
    Object.assign(this, { runtime, providers, grants, hostId: String(hostId).toLowerCase(), config: c, now, log });
    const all = hostServiceNames(this.hostId, c.zone);
    this.granted = Object.values(all);   // the exit grants every derived name; only the configured roles answer
    this.names = Object.fromEntries(Object.entries(c.ports).map(([role, p]) => [all[role], { http: c.tls ? c.tls.httpPort : p, tls: c.tls?.tlsPorts[role] || null }]));
    this.circuits = new Map(); this.cooldown = new Map(); this.strikes = new Map(); this.closed = false; this.busy = false;
  }
  /**
   * The role -> public URL an operator may advertise NOW. https only while G3 is READY for that role (605's interface): a
   * TLS handshake to 127.0.0.1:tlsPorts[role] for the derived name VERIFIES against the trusted roots with the default
   * hostname check (service-tls listens only while it holds a valid certificate and the host is admitted, so a refused
   * connection or a failed verification both mean not ready). A configured TLS port alone never makes a URL https.
   * roots: tests inject a fixture CA; production uses Node's bundled roots.
   */
  async endpoints({ roots = undefined, timeoutMs = 3000 } = {}) {
    const all = hostServiceNames(this.hostId, this.config.zone), out = {};
    for (const r of Object.keys(this.config.ports)) {
      const port = this.config.tls?.tlsPorts[r];
      out[r] = `${port && await tlsReady({ port, servername: all[r], roots, timeoutMs }) ? 'https' : 'http'}://${all[r]}/`;
    }
    return out;
  }
  async start() { await this.reconcile(); this.timer = setInterval(() => void this.reconcile().catch((e) => this.log('host service circuits: ' + e.message)), 15000); this.timer.unref?.(); return this; }
  // a guard for `exit`: qualified, free, not the exit, not cooling down; cheapest, longest qualified, then id (as selectNetworkCircuits)
  pick(providers, exit) {
    const now = this.now(), fits = (p) => p.pricePerGiB6 <= 0 && p.qualifiedUntil > now && !((this.cooldown.get(p.providerId) || 0) > now);
    const order = (a, b) => a.pricePerGiB6 - b.pricePerGiB6 || b.qualifiedUntil - a.qualifiedUntil || a.providerId.localeCompare(b.providerId);
    return providers.filter((p) => fits(p) && p.eligibleRoles.includes('guard') && p.address !== exit.address).sort(order)[0] || null;
  }
  async reconcile() {
    if (this.busy || this.closed) return; this.busy = true;
    try {
      const providers = await this.providers(), byId = new Map(providers.map((p) => [p.providerId, p])), now = this.now();
      for (const [id, c] of [...this.circuits]) {
        const x = byId.get(id), g = byId.get(c.providers.guard.providerId);
        const ok = x && g && x.address === c.providers.exit.address && x.wgExitKey === c.providers.exit.wgExitKey && x.eligibleRoles.includes('ingress') &&
          g.address === c.providers.guard.address && g.wgGuardKey === c.providers.guard.wgGuardKey && g.eligibleRoles.includes('guard');
        if (!ok || c.closed) await this.drop(id, ok ? 'closed' : 'provider no longer qualified');
      }
      for (const id of this.config.exits) {
        if (this.closed) return;
        if (this.circuits.has(id)) continue;
        const exit = byId.get(id);
        if (!exit || !(exit.qualifiedUntil > now) || !exit.eligibleRoles.includes('ingress') || exit.pricePerGiB6 > 0 || (this.cooldown.get(id) || 0) > now) continue;
        const guard = this.pick(providers, exit);
        if (!guard) { this.log(`host service circuit to ${exit.region || exit.address}: no qualified guard`); continue; }
        let c;
        try {
          c = await this.runtime.start({ deploymentId: ZERO, names: [], kind: 'network', guard, exit, ingress: true, egress: false, exitRole: 'service', gate: () => !this.closed,
            service: { names: this.names, granted: this.granted, dns: this.config.dns } });
          c.on('down', (reason) => { if (this.circuits.get(id) === c) { this.circuits.delete(id); this.log(`host service circuit down (${exit.region || exit.address}): ${reason}`); } });
          this.circuits.set(id, c); this.strikes.delete(guard.providerId); this.strikes.delete(id);
          this.log(`host service circuit up: guard ${guard.region || guard.address} -> exit ${exit.region || exit.address} (${this.granted.length} names)`);
        } catch (e) {
          await c?.close(e.message);
          const p = e.providerRole === 'guard' ? guard : exit;
          if ((this.cooldown.get(p.providerId) || 0) <= this.now()) { const n = (this.strikes.get(p.providerId) || 0) + 1; this.strikes.set(p.providerId, n); this.cooldown.set(p.providerId, this.now() + Math.min(60000 * 2 ** (n - 1), COOLDOWN_MAX_MS)); }
          this.log('host service circuit: ' + e.message);
        }
      }
    } finally { this.busy = false; }
  }
  // withdraw the grant at the exit first (through the guard, while the circuit still carries it), then close
  async drop(id, reason) {
    const c = this.circuits.get(id); if (!c) return; this.circuits.delete(id);
    if (c.service && !c.closed) await this.grants.revoke({ provider: c.providers.exit, url: `http://${c.service.control}`, wgPublicKey: c.service.exitKey })
      .catch((e) => this.log(`host service revoke at ${c.providers.exit.address}: ${e.message} (the grant expires on its own)`));
    await c.close(reason); this.log('host service circuit down: ' + reason);
  }
  status() { return { names: this.granted, circuits: [...this.circuits.entries()].map(([id, c]) => ({ exit: id, address: c.providers.exit.address, healthy: !c.closed })) }; }
  async close() { this.closed = true; clearInterval(this.timer); for (const id of [...this.circuits.keys()]) await this.drop(id, 'stopped'); }
}
