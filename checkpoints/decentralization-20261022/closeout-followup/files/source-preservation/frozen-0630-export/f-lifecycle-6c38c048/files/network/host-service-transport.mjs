// The host's PUBLIC SERVICE roles on the Enclave network (work/host-service-transport-20261021): directory replica,
// bootstrap replica and policy mirror (and route-dns's DNS 53) reached by the public through WireGuard providers that
// forward raw packets only. One guarded 'service' circuit per exit provider the operator names (the providers whose
// addresses the service names resolve to): the exit grants exactly this host's derived names (host-service-names.mjs) and
// routes them by SNI/Host to this circuit; the host-service worker maps each to its loopback role port. Same shape as
// WgControlTransport (start(), reconcile(), close()).
//
// config (cfg.enclaveNetwork.hostServices): { zone, exits: [providerId, ...] (1-8),
//   ports: { "directory-replica": 18188, "bootstrap-replica": 18189, "policy-mirror": 18190 } (any subset, loopback),
//   tls?: { httpPort, tlsPorts: { <role>: port },      (G3, the host's service-tls role, work/host-service-tls-20261021:
//           challengePort? }                           (challengePort: the host's attested challenge origin
//                                                        chal-<b32>.<zone> - its 443 goes there and its 80 to httpPort for
//                                                        http-01 only; the exits must grant it, i.e. their operator opted in
//                                                        with hostServices.challenge, work/challenge-host-tls-20261021)
//                                                        port 80 of every derived name goes to its front httpPort -
//                                                        ACME http-01 plus raw passthrough - and 443 to tlsPorts[role];
//                                                        a role without a TLS port is closed on 443),
//   dns?: { tcp: 18153, udp: 18153 } }                 (route-dns; the exit forwards 53 only if its operator pins this host)
import tls from 'node:tls';
import { hostServiceNames, hostChallengeName, HOST_SERVICE_ROLES, validServiceZone } from './host-service-names.mjs';
const ZERO = '0x' + '0'.repeat(64), COOLDOWN_MAX_MS = 30 * 60000;
// close() waits this long for a circuit startup it cancelled (a grant request already sent finishes or times out, 15 s, and
// its withdrawal is sent, 15 s); a startup that answers even later is still withdrawn and closed when it does, never used
const SETTLE_MS = 90_000;
const port = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;

export function validateHostServicesTransport(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('hostServices must be an object');
  for (const k of Object.keys(c)) if (!['zone', 'exits', 'ports', 'tls', 'dns'].includes(k)) throw new Error(`hostServices: unknown field ${JSON.stringify(k)}`);
  validServiceZone(c.zone);
  if (!Array.isArray(c.exits) || c.exits.length < 1 || c.exits.length > 8 || c.exits.some((x) => typeof x !== 'string' || !/^[0-9a-f]{16,64}$/.test(x))) throw new Error('hostServices.exits: 1 to 8 provider ids');
  const roles = Object.keys(HOST_SERVICE_ROLES);
  if (!c.ports || typeof c.ports !== 'object' || !Object.keys(c.ports).length || Object.entries(c.ports).some(([r, p]) => !roles.includes(r) || !port(p))) throw new Error(`hostServices.ports: loopback ports of ${roles.join(', ')}`);
  if (c.tls !== undefined) {
    const t = c.tls, ok = t && typeof t === 'object' && !Object.keys(t).some((k) => !['httpPort', 'tlsPorts', 'challengePort'].includes(k)) && port(t.httpPort) &&
      t.tlsPorts && typeof t.tlsPorts === 'object' && Object.keys(t.tlsPorts).length && Object.entries(t.tlsPorts).every(([r, p]) => c.ports[r] && port(p)) &&
      (t.challengePort === undefined || port(t.challengePort));
    if (!ok) throw new Error('hostServices.tls: { httpPort, tlsPorts: { <served role>: port }, challengePort? }');
    const all = [...Object.values(c.ports), t.httpPort, ...Object.values(t.tlsPorts), ...(t.challengePort !== undefined ? [t.challengePort] : [])];
    if (new Set(all).size !== all.length) throw new Error('hostServices.tls: the front and TLS ports must differ from each other and from the role ports');
  }
  // route-dns answers UDP and TCP on ONE port; the host relays both over its TCP listener (a Windows circuit sandbox grants
  // loopback TCP only), so the two must name the same port
  if (c.dns !== undefined && (!c.dns || typeof c.dns !== 'object' || Object.keys(c.dns).some((k) => !['tcp', 'udp'].includes(k)) || !port(c.dns.tcp) || c.dns.udp !== c.dns.tcp)) throw new Error('hostServices.dns: {tcp, udp}: route-dns\'s one loopback port (both the same)');
  // absent blocks stay ABSENT (not null), so the normalized form validates again unchanged (privacy-agent validates, then
  // HostServiceTransport validates what it is given)
  return { zone: c.zone, exits: [...new Set(c.exits)], ports: { ...c.ports },
    ...(c.tls ? { tls: { httpPort: c.tls.httpPort, tlsPorts: { ...c.tls.tlsPorts }, ...(c.tls.challengePort !== undefined ? { challengePort: c.tls.challengePort } : {}) } } : {}),
    ...(c.dns ? { dns: { tcp: c.dns.tcp, udp: c.dns.udp } } : {}) };
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
  constructor({ runtime, providers, grants, hostId, config, now = Date.now, log = () => {}, settleMs = SETTLE_MS }) {
    const c = validateHostServicesTransport(config);
    Object.assign(this, { runtime, providers, grants, hostId: String(hostId).toLowerCase(), config: c, now, log, settleMs });
    const all = hostServiceNames(this.hostId, c.zone);
    // the exit grants every derived name (plus the challenge origin when its operator opted in); only the configured roles answer
    const chal = c.tls?.challengePort !== undefined ? hostChallengeName(this.hostId, c.zone) : null;
    this.granted = [...Object.values(all), ...(chal ? [chal] : [])];
    this.names = Object.fromEntries(Object.entries(c.ports).map(([role, p]) => [all[role], { http: c.tls ? c.tls.httpPort : p, tls: c.tls?.tlsPorts[role] || null }]));
    if (chal) this.names[chal] = { http: c.tls.httpPort, tls: c.tls.challengePort };   // 80: http-01 only (service-tls); 443: the challenge front
    this.circuits = new Map(); this.cooldown = new Map(); this.strikes = new Map(); this.closed = false;
    // lifecycle: `running` is the reconcile in flight (one at a time); `stopping` cancels its circuit startups on close()
    this.running = null; this.closing = null; this.timer = null; this.stopping = new AbortController();
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
  // a first round that cannot read any directory is logged, never thrown: the 15 s timer retries, and the privacy agent's
  // apps start regardless (final review N3)
  // A close() during this first round cancels it and creates no timer (the round's late result is withdrawn, never used).
  async start() {
    await this.reconcile().catch((e) => this.log('host service circuits: ' + e.message));
    if (this.closed) return this;
    this.timer = setInterval(() => void this.reconcile().catch((e) => this.log('host service circuits: ' + e.message)), 15000); this.timer.unref?.();
    return this;
  }
  // a guard for `exit`: qualified, free, not the exit, not cooling down; cheapest, longest qualified, then id (as selectNetworkCircuits)
  pick(providers, exit) {
    const now = this.now(), fits = (p) => p.pricePerGiB6 <= 0 && p.qualifiedUntil > now && !((this.cooldown.get(p.providerId) || 0) > now);
    const order = (a, b) => a.pricePerGiB6 - b.pricePerGiB6 || b.qualifiedUntil - a.qualifiedUntil || a.providerId.localeCompare(b.providerId);
    return providers.filter((p) => fits(p) && p.eligibleRoles.includes('guard') && p.address !== exit.address).sort(order)[0] || null;
  }
  // one round at a time: a call while one runs gets that round
  reconcile() {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    const run = this.running = this.round().finally(() => { if (this.running === run) this.running = null; });
    return run;
  }
  async round() {
    const providers = await this.providers(), byId = new Map(providers.map((p) => [p.providerId, p])), now = this.now();
    for (const [id, c] of [...this.circuits]) {
      const x = byId.get(id), g = byId.get(c.providers.guard.providerId);
      const ok = x && g && x.address === c.providers.exit.address && x.wgExitKey === c.providers.exit.wgExitKey && x.eligibleRoles.includes('ingress') &&
        g.address === c.providers.guard.address && g.wgGuardKey === c.providers.guard.wgGuardKey && g.eligibleRoles.includes('guard');
      if (!ok || c.closed) await this.drop(id, ok ? 'closed' : 'provider no longer qualified');
      if (this.closed) return;
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
          service: { names: this.names, granted: this.granted, dns: this.config.dns }, signal: this.stopping.signal });
        // stopped while it came up (a runtime that finished before it saw the stop): withdrawn and closed, never served
        if (this.closed) { await this.retire(c, 'stopped during startup'); return; }
        c.on('down', (reason) => { if (this.circuits.get(id) === c) { this.circuits.delete(id); this.log(`host service circuit down (${exit.region || exit.address}): ${reason}`); } });
        this.circuits.set(id, c); this.strikes.delete(guard.providerId); this.strikes.delete(id);
        this.log(`host service circuit up: guard ${guard.region || guard.address} -> exit ${exit.region || exit.address} (${this.granted.length} names)`);
      } catch (e) {
        await c?.close(e.message);
        if (this.closed || e.cancelled) { this.log('host service circuit startup ended: ' + e.message); return; }   // our stop, not the providers'
        const p = e.providerRole === 'guard' ? guard : exit;
        if ((this.cooldown.get(p.providerId) || 0) <= this.now()) { const n = (this.strikes.get(p.providerId) || 0) + 1; this.strikes.set(p.providerId, n); this.cooldown.set(p.providerId, this.now() + Math.min(60000 * 2 ** (n - 1), COOLDOWN_MAX_MS)); }
        this.log('host service circuit: ' + e.message);
      }
    }
  }
  // withdraw the grant at the exit first (through the guard, while the circuit still carries it), then close
  async drop(id, reason) {
    const c = this.circuits.get(id); if (!c) return; this.circuits.delete(id);
    await this.retire(c, reason);
  }
  async retire(c, reason) {
    if (c.service && !c.closed) await this.grants.revoke({ provider: c.providers.exit, url: `http://${c.service.control}`, wgPublicKey: c.service.exitKey })
      .catch((e) => this.log(`host service revoke at ${c.providers.exit.address}: ${e.message} (the grant expires on its own)`));
    await c.close(reason); this.log('host service circuit down: ' + reason);
  }
  status() { return { names: this.granted, circuits: [...this.circuits.entries()].map(([id, c]) => ({ exit: id, address: c.providers.exit.address, healthy: !c.closed })) }; }
  // Idempotent (every call gets the same promise). Order: no new round or timer; the startups in flight are cancelled; the
  // live circuits are withdrawn at their exits and closed; then the cancelled round is awaited (bounded, SETTLE_MS) so a
  // circuit it was still building ends withdrawn too. Resolves with no circuit, no timer and (within the bound) no startup.
  close() {
    if (this.closing) return this.closing;
    this.closed = true; clearInterval(this.timer); this.timer = null; this.stopping.abort(new Error('host services stopped'));
    this.closing = (async () => {
      for (const id of [...this.circuits.keys()]) await this.drop(id, 'stopped');
      const run = this.running;
      if (run) {
        let t; const settled = await Promise.race([run.then(() => true, () => true), new Promise((r) => { t = setTimeout(() => r(false), this.settleMs); t.unref?.(); })]);
        clearTimeout(t);
        if (!settled) this.log(`host service circuit startup still running ${this.settleMs / 1000} s after the stop: it is withdrawn and closed when it ends`);
      }
      for (const id of [...this.circuits.keys()]) await this.drop(id, 'stopped');
    })();
    return this.closing;
  }
}

/**
 * The privacy agent's host-service switch (one HostServiceTransport at a time, following the platform host policy).
 * judge() (every 2 s, and after the policy's first check): a refusal stops the current transport - also one still in its
 * first round, which is cancelled (close()) rather than waited for, so a ban known during startup is acted on at once;
 * an admit with none running creates a FRESH transport and starts it without waiting (a later refusal stops it the same
 * way). A transport that cannot be built (invalid config) refuses host services for this process, loudly; the apps are
 * never touched. A start that settles after its transport was replaced or stopped closes that transport (idempotent),
 * never the current one. close(): no new transport, and resolves once every transport it stopped has closed.
 * refusal() -> reason|null (createHostServiceGate serviceRefusal); create() -> HostServiceTransport
 */
export function hostServiceLifecycle({ refusal, create, log = () => {} }) {
  let current = null, judging = false, held = '', refused = false, stopped = false;
  const closing = new Set();
  const stop = (h) => { const p = h.close().catch((e) => log('host services: ' + e.message)).finally(() => closing.delete(p)); closing.add(p); return p; };
  async function judge() {
    if (judging || stopped || refused) return; judging = true;
    try {
      const reason = refusal();
      if (reason) {
        if (current) { const h = current; current = null; log('host services stopped: ' + reason); await stop(h); }
        else if (reason !== held) log('host services held: ' + reason);
        held = reason; return;
      }
      held = ''; if (current) return;
      let h;
      try { h = create(); } catch (e) { refused = true; log('HOST SERVICES REFUSED (apps unaffected): ' + e.message); return; }
      current = h; log('host services: ' + JSON.stringify(h.names));
      void h.start().then(() => { if (current !== h) return stop(h); }, (e) => {
        log('HOST SERVICES REFUSED (apps unaffected): ' + e.message);
        if (current === h) { current = null; refused = true; }
        return stop(h);
      });
    } finally { judging = false; }
  }
  return {
    judge,
    get current() { return current; },
    get refused() { return refused; },
    async close() { stopped = true; const h = current; current = null; if (h) stop(h); await Promise.all([...closing]); },
  };
}
