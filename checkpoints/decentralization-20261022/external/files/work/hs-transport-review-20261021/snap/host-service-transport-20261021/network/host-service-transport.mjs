// The host's PUBLIC SERVICE roles on the Enclave network (work/host-service-transport-20261021): directory replica,
// bootstrap replica and policy mirror (and route-dns's DNS 53) reached by the public through WireGuard providers that
// forward raw packets only. One guarded 'service' circuit per exit provider the operator names (the providers whose
// addresses the service names resolve to): the exit grants exactly this host's derived names (host-service-names.mjs) and
// routes them by SNI/Host to this circuit; the host-service worker maps each to its loopback role port. Same shape as
// WgControlTransport (start(), reconcile(), close()).
//
// config (cfg.enclaveNetwork.hostServices): { zone, exits: [providerId, ...] (1-8),
//   ports: { "directory-replica": 18188, "bootstrap-replica": 18189, "policy-mirror": 18190 } (any subset, loopback),
//   tls?: { <role>: <loopback TLS terminator port> }   (G3; without one a role's 443 is closed),
//   dns?: { tcp: 18153, udp: 18153 } }                 (route-dns; the exit forwards 53 only if its operator pins this host)
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
  if (c.tls !== undefined && (!c.tls || typeof c.tls !== 'object' || Object.entries(c.tls).some(([r, p]) => !c.ports[r] || !port(p)))) throw new Error('hostServices.tls: a TLS port per served role');
  if (c.dns !== undefined && (!c.dns || typeof c.dns !== 'object' || Object.keys(c.dns).some((k) => !['tcp', 'udp'].includes(k)) || !port(c.dns.tcp) || !port(c.dns.udp))) throw new Error('hostServices.dns: {tcp, udp} loopback ports of route-dns');
  return { zone: c.zone, exits: [...new Set(c.exits)], ports: { ...c.ports }, tls: { ...(c.tls || {}) }, dns: c.dns ? { tcp: c.dns.tcp, udp: c.dns.udp } : null };
}

export class HostServiceTransport {
  // runtime: WgCircuitRuntime (with serviceWorkerModule); providers(): verified provider records (eligibleRoles,
  // qualifiedUntil); grants: WgGrants (revoke); hostId: this host's registry id (the runner)
  constructor({ runtime, providers, grants, hostId, config, now = Date.now, log = () => {} }) {
    const c = validateHostServicesTransport(config);
    Object.assign(this, { runtime, providers, grants, hostId: String(hostId).toLowerCase(), config: c, now, log });
    const all = hostServiceNames(this.hostId, c.zone);
    this.granted = Object.values(all);   // the exit grants every derived name; only the configured roles answer
    this.names = Object.fromEntries(Object.entries(c.ports).map(([role, p]) => [all[role], { http: p, tls: c.tls[role] || null }]));
    this.circuits = new Map(); this.cooldown = new Map(); this.strikes = new Map(); this.closed = false; this.busy = false;
  }
  /** the role -> public name map an operator advertises (http:// until a role has a TLS port) */
  endpoints() {
    const all = hostServiceNames(this.hostId, this.config.zone);
    return Object.fromEntries(Object.keys(this.config.ports).map((r) => [r, `${this.config.tls[r] ? 'https' : 'http'}://${all[r]}/`]));
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
  status() { return { names: this.granted, endpoints: this.endpoints(), circuits: [...this.circuits.entries()].map(([id, c]) => ({ exit: id, address: c.providers.exit.address, healthy: !c.closed })) }; }
  async close() { this.closed = true; clearInterval(this.timer); for (const id of [...this.circuits.keys()]) await this.drop(id, 'stopped'); }
}
