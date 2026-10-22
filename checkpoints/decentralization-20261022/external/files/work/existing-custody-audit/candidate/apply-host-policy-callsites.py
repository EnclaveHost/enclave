#!/usr/bin/env python3
"""Apply the platform host policy CALL SITES to a source tree (current main, or main + heartbeat overlay): every edit is
anchored on one exact, unique snippet and fails loudly if the anchor moved, so it never blanket-overwrites another
worker's changes. Usage: apply-host-policy-callsites.py <tree root>"""
import sys, os
ROOT = sys.argv[1]
done = []; skipped = []
def edit(path, pairs):
    p = os.path.join(ROOT, path); s = open(p).read()
    for pair in pairs:
        old, new = pair[:2]
        # optional third element: a marker proving root ALREADY integrated an equivalent hunk -> skip, never re-apply
        if len(pair) > 2 and pair[2] in s and s.count(old) != 1: skipped.append(f"{path}: {pair[2][:60]!r}"); continue
        n = s.count(old)
        if n != 1: raise SystemExit(f"{path}: anchor found {n} times: {old[:100]!r}")
        s = s.replace(old, new)
    open(p, "w").write(s); done.append(path)

# ---------------------------------------------------------------- shared bundles (deployment closure)
edit("network/host-admission-runtime.mjs", [(
"export {loadContractPins,validateContractPins} from './contract-pins.mjs';",
"""export {loadContractPins,validateContractPins} from './contract-pins.mjs';
// The platform host policy for host runtimes (supervisor.js, the Windows node host), shipped in THIS bundle so both
// platforms' existing deployment closures (Dockerfile, metal image, windows/node/deploy-files.mjs) already contain it.
export {createHostServiceGate,hostIdOfEndpoint,resolveHostPolicyConfig} from './host-service-gate.mjs';""")])
edit("relay/network-runtime.mjs", [(
"export {createNetworkApi} from './network-api.mjs';",
"""export {createNetworkApi} from './network-api.mjs';
// The platform host policy (relay discovery/dial/tunnel attach and hot-ban/routes, and the DNS fleet), in the same shipped
// bundle: relay/deploy.sh already builds, ships and smoke-starts it, so the flat relay directory needs no new module.
export {createHostPolicyRuntime,resolveHostPolicyConfig} from '../network/host-policy-runtime.mjs';
export {leaseHostAdmission,hostAdmissions,endpointAdmissions,freshAdmissions} from '../network/host-policy-adapters.mjs';""")])

# ---------------------------------------------------------------- relay: api-relay
edit("relay/api-relay.js", [
("import {LeaseReader,createNetworkRoutes,DurableState,createLeaseSource,createRegistryOperator,createNetworkApi} from \"./network-runtime.bundle.mjs\";",
 "import {LeaseReader,createNetworkRoutes,DurableState,createLeaseSource,createRegistryOperator,createNetworkApi,\n        createHostPolicyRuntime,resolveHostPolicyConfig,leaseHostAdmission,freshAdmissions} from \"./network-runtime.bundle.mjs\";"),
("async function tunnelNameOwner(name) {",
 """// PLATFORM HOST POLICY (network/platform-host-policy-config.mjs): ON for the production chain and address book
// (ADDRESS_BOOK_ADDRESS = the admin's EnclaveAddressBook) and ACTIVATED by the admin's anchor; ENCLAVE_PLATFORM_HOST_POLICY
// overrides (production | off | JSON). Enforced IN ADDITION to TRUSTED_OPERATORS on discovery/dial, tunnel attach (and a
// hot-ban sweep of attached tunnels) and route verification. Undecided (policy unreadable, behind the anchor) admits nothing new.
const HOST_POLICY_RESOLVED = resolveHostPolicyConfig({ env: process.env, chainId: 8453, book: (process.env.ADDRESS_BOOK_ADDRESS || "").trim() || null });
const HOST_POLICY = createHostPolicyRuntime(HOST_POLICY_RESOLVED, { log: (m) => console.log(m) });
if (HOST_POLICY) {
  console.log(`[host-policy] platform host policy ON (${HOST_POLICY_RESOLVED.source}; activation ${HOST_POLICY.activation})`);
  const refresh = () => HOST_POLICY.gate.refresh().then((p) => { if (p) console.log(`[host-policy] platform policy #${p.policy.sequence} ${p.digest.slice(0, 18)}...`); },
    (e) => console.error(`[host-policy] refresh failed (${e.code || "error"}): ${e.message}`));
  refresh(); setInterval(refresh, 5 * 60_000).unref();
} else console.log(`[host-policy] platform host policy off: ${HOST_POLICY_RESOLVED.reason}`);
// attach/listing use the bounded admit cache (30 s); the tunnel hub's hot-ban sweep asks { fresh: true } (uncached)
const hostPolicyFresh = HOST_POLICY ? freshAdmissions(HOST_POLICY.gate) : null;
const hostPolicyAdmission = HOST_POLICY ? async (name, { fresh = false } = {}) => {
  const id = String(await endpointId(boxOrigin(name) || `${TUNNEL_ORIGIN}/t/${name}`)).toLowerCase();
  return (await (fresh ? hostPolicyFresh : HOST_POLICY.admissions)([id]))[id] || { admit: false, reason: "no decision" };
} : null;

async function tunnelNameOwner(name) {"""),
("  trustedOperators: TRUSTED_OPERATORS, operatorsUnrestricted: OPERATORS_UNRESTRICTED,",
 "  trustedOperators: TRUSTED_OPERATORS, operatorsUnrestricted: OPERATORS_UNRESTRICTED, hostAdmission: hostPolicyAdmission,\n  hostPolicyRecheckMs: Math.max(1, Number(process.env.HOST_POLICY_RECHECK_SEC) || 60) * 1000,   // the hot-ban sweep of attached tunnels"),
("""  return Promise.all(admitted
    // B2: only vetted operators (baked default, or the env allowlist). Pass-all
    // ONLY under the explicit TRUSTED_OPERATORS=* opt-in — never by omission.
    .filter((e) => OPERATORS_UNRESTRICTED || TRUSTED_OPERATORS.includes(String(e.operator || "").toLowerCase()))""",
 """  // platform host policy: one agreed decision per admitted row; a host without an explicit admit is never listed or dialed
  const policyIds = HOST_POLICY ? (await Promise.all(admitted.map((e) => endpointId(String(e.endpoint || "").replace(/\\/+$/, ""))))).map((x) => String(x).toLowerCase()) : null;
  const policyDecisions = HOST_POLICY ? await HOST_POLICY.admissions(policyIds).catch((e) => { console.error(`[host-policy] ${e.message}`); return {}; }) : null;
  return Promise.all(admitted
    // B2: only vetted operators (baked default, or the env allowlist). Pass-all
    // ONLY under the explicit TRUSTED_OPERATORS=* opt-in — never by omission.
    .filter((e, i) => (OPERATORS_UNRESTRICTED || TRUSTED_OPERATORS.includes(String(e.operator || "").toLowerCase()))
                      && (!policyDecisions || policyDecisions[policyIds[i]]?.admit === true))"""),
("""networkRoutes = createNetworkRoutes({
  network: networkApi,""", """networkRoutes = createNetworkRoutes({
  network: networkApi,
  // platform host policy on the route's lease host (network/route-record.mjs verifyRoute hostAdmission)
  hostAdmission: HOST_POLICY ? leaseHostAdmission(HOST_POLICY.gate) : null,"""),
("""  if (u.pathname === "/health")
    return json(res, 200, { ok: true, enclaves: live.length, of: registry.length, updatedAt }, req);""",
 """  if (u.pathname === "/health")
    return json(res, 200, { ok: true, enclaves: live.length, of: registry.length, updatedAt }, req);
  // the platform host policy as this relay enforces it, and (?host=<registry id>) its decision for one host now
  if (u.pathname === "/v1/platform-host-policy") {
    if (!HOST_POLICY) return json(res, 200, { platformHostPolicy: "off", reason: HOST_POLICY_RESOLVED.reason }, req);
    const host = String(u.searchParams.get("host") || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(host)) return json(res, 200, { platformHostPolicy: "on", ...HOST_POLICY.status() }, req);
    return HOST_POLICY.admissions([host]).then((d) => ({ admit: d[host]?.admit === true, status: d[host]?.status, reason: d[host]?.reason || null }),
      (e) => ({ admit: false, status: "unreadable", reason: e.message }))
      .then((decision) => json(res, 200, { platformHostPolicy: "on", ...HOST_POLICY.status(), host, decision }, req));
  }"""),
])

# ---------------------------------------------------------------- relay: tunnel hub (every attach path + hot ban)
edit("relay/tunnel.js", [
("                                  trustedOperators = [], operatorsUnrestricted = false,",
 """                                  trustedOperators = [], operatorsUnrestricted = false,
                                  // platform host policy (relay/api-relay.js): hostAdmission(name) -> { admit, status, reason };
                                  // null = off. Every attach path asks it; attached tunnels are re-asked (hot ban) every hostPolicyRecheckMs.
                                  hostAdmission = null, hostPolicyRecheckMs = 60_000,"""),
("""  async function recheckOwnerOnly() {""",
 """  // HOT BAN: an attached box the platform policy now EXPLICITLY refuses (ban, allowlist miss, deregistered) is cut off at
  // once - terminated and removed from discovery. An undecided answer (RPC outage, node behind the anchor) leaves an
  // attached box alone (new attaches are refused meanwhile); only an explicit refusal detaches.
  const EXPLICIT_REFUSAL = new Set(["current", "stale-grace", "stale", "inactive"]);
  async function recheckHostPolicy() {
    for (const [name, t] of [...tunnels]) {
      let d; try { d = await hostAdmission(name, { fresh: true }); } catch { continue; }
      if (tunnels.get(name) !== t || d?.admit === true || !EXPLICIT_REFUSAL.has(d?.status)) continue;
      console.error(`[tunnel] ${name} DETACHED by the platform host policy: ${d.reason}`);
      try { t.ws.send(JSON.stringify({ t: "detach", reason: `platform host policy: ${d.reason}` })); } catch {}
      try { t.ws.terminate(); } catch {}
      if (tunnels.get(name) === t) { tunnels.delete(name); try { onChange("detach", name); } catch {} }
    }
  }
  if (hostAdmission) setInterval(() => recheckHostPolicy().catch((e) => console.error(`[tunnel] host policy recheck: ${e.message}`)), hostPolicyRecheckMs).unref?.();
  const policyRefusal = async (name) => {
    if (!hostAdmission) return null;
    const d = await hostAdmission(name).catch((e) => ({ admit: false, reason: e.message }));
    return d && d.admit === true ? null : `${name} is refused by the platform host policy: ${d?.reason || "no decision"}`;
  };

  async function recheckOwnerOnly() {"""),
("""    if (tokenOk(name, token)) return wss.handleUpgrade(req, socket, head, (ws) => bind(name, ws, { via: "token", referral }));""",
 """    if (tokenOk(name, token)) {
      if (!hostAdmission) return wss.handleUpgrade(req, socket, head, (ws) => bind(name, ws, { via: "token", referral }));
      return policyRefusal(name).then((why) => {
        if (why) { console.log(`[tunnel] ${name} token attach REFUSED: ${why}`); socket.write("HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\n\\r\\n"); return socket.destroy(); }
        wss.handleUpgrade(req, socket, head, (ws) => bind(name, ws, { via: "token", referral }));
      });
    }"""),
("""            clearTimeout(timer); settled = true;
            try { ws.send(JSON.stringify({ t: "attest-result", ok: true })); } catch {}
            bind(name, ws, { via: "operator", referral });""",
 """            const policyWhy = await policyRefusal(name);
            if (settled) return;
            if (policyWhy) return deny(policyWhy);
            clearTimeout(timer); settled = true;
            try { ws.send(JSON.stringify({ t: "attest-result", ok: true })); } catch {}
            bind(name, ws, { via: "operator", referral });"""),
("""            if (!res.ok) return deny(res.reasons[res.reasons.length - 1] || "quote invalid");""",
 """            if (!res.ok) return deny(res.reasons[res.reasons.length - 1] || "quote invalid");
            { const policyWhy = await policyRefusal(name); if (settled) return; if (policyWhy) return deny(policyWhy); }"""),
])

# ---------------------------------------------------------------- relay: fleet (DNS relay's data-plane fleet and dns-01 authority)
edit("relay/fleet.mjs", [
("""    const admitted = rows.filter((e) => e.active === true);""",
 """    // platform host policy (cfg.hostAdmission, injected by the DNS relay from relay/network-runtime.bundle.mjs): a host the
    // policy does not explicitly admit gets neither data-plane traffic nor dns-01 for its own name. A failed policy read
    // throws, so refresh() keeps the last known fleet (a flaky RPC never unbinds or admits anyone).
    const active = rows.filter((e) => e.active === true);
    const policy = cfg.hostAdmission ? await cfg.hostAdmission(active.map((e) => String(e.endpoint || ""))) : null;
    const admitted = policy ? active.filter((e) => policy[String(e.endpoint || "").replace(/\\/+$/, "")]?.admit === true) : active;"""),
])
edit("relay/dns-relay.js", [
("""import { createFleet, fleetConfig, fetchJson, installProcessGuards } from "./fleet.mjs";""",
 """import { createFleet, fleetConfig, fetchJson, installProcessGuards } from "./fleet.mjs";
import { createHostPolicyRuntime, resolveHostPolicyConfig, endpointAdmissions } from "./network-runtime.bundle.mjs";"""),
("""const fleet     = READ_ONLY || ATTESTED ? null : createFleet(CFG, (m) => console.log("[dns-relay]", m));""",
 """// platform host policy (network/platform-host-policy-config.mjs): production chain + book => on, activated by the admin's anchor
const HOST_POLICY = READ_ONLY || ATTESTED ? null : createHostPolicyRuntime(resolveHostPolicyConfig({ env: process.env, chainId: 8453, book: CFG.addressBook || null }),
  { log: (m) => console.log("[dns-relay]", m) });
if (HOST_POLICY) { CFG.hostAdmission = endpointAdmissions(HOST_POLICY.admissions); const r = () => HOST_POLICY.gate.refresh().catch((e) => console.error(`[dns-relay] host policy: ${e.message}`)); r(); setInterval(r, 5 * 60_000).unref(); }
const fleet     = READ_ONLY || ATTESTED ? null : createFleet(CFG, (m) => console.log("[dns-relay]", m));"""),
])
edit("relay/deploy.sh", [
(" shield-marketplace.mjs shield-app-fresh.mjs ", " shield-marketplace.mjs shield-market-evidence.mjs shield-app-fresh.mjs ", " shield-marketplace.mjs shield-market-evidence.mjs shield-app-fresh.mjs "),
("""  scp dns-relay.js fleet.mjs net-guard.mjs fleet-auth.js boxhost.js package.json package-lock.json "$DNS_HOST":/opt/nan-relay/""",
 """  # dns-relay.js imports the platform host policy from the network runtime bundle (built from the pinned lockfiles here)
  [ -d ../node_modules/esbuild ] || (cd .. && npm ci --no-audit --no-fund --ignore-scripts)
  [ -d node_modules/viem ] || npm ci --no-audit --no-fund --ignore-scripts
  node build-network.mjs
  scp dns-relay.js fleet.mjs net-guard.mjs fleet-auth.js boxhost.js network-runtime.bundle.mjs network-runtime.bundle.mjs.manifest.json package.json package-lock.json "$DNS_HOST":/opt/nan-relay/""",
 "scp dns-relay.js fleet.mjs net-guard.mjs fleet-auth.js boxhost.js network-runtime.bundle.mjs network-runtime.bundle.mjs.manifest.json"),
])

# ---------------------------------------------------------------- routes and native app access
edit("relay/network-routes.mjs", [
("export function createNetworkRoutes({ operatorOf, endpointId, eligible, now = Date.now, leaseOf, memory, network }) {",
 "export function createNetworkRoutes({ operatorOf, endpointId, eligible, now = Date.now, leaseOf, memory, network, hostAdmission = null }) {"),
("const record = await verifyRoute(bundle, {deploymentId: id, policy, lease, memory, networkProviders: await network.eligible(), providerProbeSigners: network.checkers, now: now()});",
 "const record = await verifyRoute(bundle, {deploymentId: id, policy, lease, memory, networkProviders: await network.eligible(), providerProbeSigners: network.checkers, hostAdmission, now: now()});"),
])
edit("network/public-directory.mjs", [
("  constructor({directory,checkers,hostOperator,leaseOf,verifyOwner,now=Date.now,maxRecords=4096,importManagement=false}) {",
 "  // hostAdmission: the platform host policy for a route's lease host (network/host-policy-adapters.mjs leaseHostAdmission)\n  constructor({directory,checkers,hostOperator,leaseOf,verifyOwner,now=Date.now,maxRecords=4096,importManagement=false,hostAdmission=null}) {"),
("    Object.assign(this,{hostOperator,leaseOf,verifyOwner,now,maxRecords,importManagement});",
 "    Object.assign(this,{hostOperator,leaseOf,verifyOwner,now,maxRecords,importManagement,hostAdmission});"),
("    return verifyRoute(publication.bundle,{deploymentId:id,policy,lease,memory:this.floors,networkProviders:providers,providerProbeSigners:this.checkers,now:this.now()});",
 "    return verifyRoute(publication.bundle,{deploymentId:id,policy,lease,memory:this.floors,networkProviders:providers,providerProbeSigners:this.checkers,hostAdmission:this.hostAdmission,now:this.now()});"),
])

# ---------------------------------------------------------------- management client (+ CLI construction)
edit("network/management-client.mjs", [
("    Object.assign(this, {deploymentId, chainId, signer, now});", "    Object.assign(this, {deploymentId, chainId, signer, now, hostAdmission});"),
("  constructor({deploymentId, chainId = 8453, authorityPins, rpc, directories, stateDir, signer, reader, fetch = globalThis.fetch, now = Date.now}) {",
 "  // hostAdmission(lease) -> {admit, reason}: the platform host policy for the host a request would go to (current lease\n  // holder or an owner-named host). Asked before anything is sent; anything but an explicit admit refuses. null = off.\n  constructor({deploymentId, chainId = 8453, authorityPins, rpc, directories, stateDir, signer, reader, fetch = globalThis.fetch, now = Date.now, hostAdmission = null}) {"),
("    const {lease, record} = o.host === 'named' ? await this.resolveHost(runner) : await this.resolve();",
 """    const {lease, record} = o.host === 'named' ? await this.resolveHost(runner) : await this.resolve();
    if (this.hostAdmission) {
      const a = await this.hostAdmission(lease);
      if (!a || a.admit !== true) throw new ManagementError(`the host is refused by the platform host policy: ${a?.reason || 'no decision'}; nothing was sent`, {status: 403, code: 'host_policy_refused'});
    }"""),
])

# ---------------------------------------------------------------- host runtimes: Linux supervisor
edit("supervisor.js", [
("import {hostAdmissionFromEnv,hostAdmissionConfigured} from './windows/node/host-admission.bundle.mjs';",
 "import {hostAdmissionFromEnv,hostAdmissionConfigured,createHostServiceGate} from './windows/node/host-admission.bundle.mjs';"),
("let _enclaveId = null;", """let _enclaveId = null;
// PLATFORM HOST POLICY for THIS host (network/host-service-gate.mjs, in the shared host-admission bundle): on for the
// production chain + address book or ENCLAVE_PLATFORM_HOST_POLICY (the measured direct guest sets it), activated by the
// admin's anchor. An explicit refusal stops new claims/deployments, app traffic and lease renewal at once (sticky until the
// admin's unban); a transient outage keeps serving within the grace after the last authenticated admit.
const HOST_POLICY_GATE = (() => {
  try { return createHostServiceGate({ env: process.env, chainId: CHAIN_ID, book: (process.env.ADDRESS_BOOK_ADDRESS || "").trim() || null,
    endpoint: PUBLIC_URL || null, stateDir: dirname(STATE_FILE), log: (m) => console.log(m) }); }
  catch (e) {                                   // on but unusable (no PUBLIC_URL, malformed config): refuse, never fail open
    console.error(`[host-policy] REFUSING work and service: ${e.message}`);
    const why = () => `platform host policy: ${e.message}`;
    return { enabled: true, start() {}, newWorkRefusal: why, serviceRefusal: why, status: () => ({ platformHostPolicy: "on", serving: false, reason: e.message }) };
  }
})();
HOST_POLICY_GATE.start();"""),
("""async function considerClaim(d, { hinted = false, forced = false, background = false } = {}) {""",
 """async function considerClaim(d, { hinted = false, forced = false, background = false } = {}) {
  { const pr = HOST_POLICY_GATE.newWorkRefusal(); if (pr) return pr; }   // a host the platform refuses takes no new work"""),
("""  if (_reach.tripped) return;
  for (const rec of deployments.values()) {
    if (!rec._onchain || rec.status !== "running" || rec._renewing) continue;""",
 """  if (_reach.tripped) return;
  if (HOST_POLICY_GATE.serviceRefusal()) return;   // refused by the platform: leases lapse and can be claimed elsewhere
  for (const rec of deployments.values()) {
    if (!rec._onchain || rec.status !== "running" || rec._renewing) continue;"""),
("""app.use("/x/:id", async (req, res) => {
  const rec = depByIdOrPrefix(req.params.id);""",
 """app.use("/x/:id", async (req, res) => {
  { const pr = HOST_POLICY_GATE.serviceRefusal(); if (pr) return fail(res, 403, "host_policy_refused", pr); }
  const rec = depByIdOrPrefix(req.params.id);"""),
("""server.on("upgrade", async (req, socket, head) => {
  const deny = (line) => { socket.write(`HTTP/1.1 ${line}\\r\\n\\r\\n`); socket.destroy(); };""",
 """server.on("upgrade", async (req, socket, head) => {
  const deny = (line) => { socket.write(`HTTP/1.1 ${line}\\r\\n\\r\\n`); socket.destroy(); };
  if (/^\\/x\\//.test(req.url || "") && HOST_POLICY_GATE.serviceRefusal()) return deny("403 Forbidden");   // platform host policy"""),
("""app.get("/v1/health", (_req, res) => res.json({ status: "ok", deployments: deployments.size,""",
 """app.get("/v1/health", (_req, res) => res.json({ status: "ok", deployments: deployments.size, platformHostPolicy: HOST_POLICY_GATE.status(),"""),
])

# ---------------------------------------------------------------- host runtimes: Windows node host
edit("windows/node/host.mjs", [
("import {hostAdmissionFromEnv} from './host-admission.bundle.mjs';",
 "import {hostAdmissionFromEnv,createHostServiceGate} from './host-admission.bundle.mjs';"),
("""    if(this.hostAdmission && (this.hostAdmission.hostId!==this.enclaveId || typeof this.hostAdmission.refusal!=='function'))
      throw new Error('wallet admission must bind this host');""",
 """    if(this.hostAdmission && (this.hostAdmission.hostId!==this.enclaveId || typeof this.hostAdmission.refusal!=='function'))
      throw new Error('wallet admission must bind this host');
    // PLATFORM HOST POLICY for THIS box - the same gate as supervisor.js (network/host-service-gate.mjs): an explicit refusal
    // stops new claims, app traffic and renewals (sticky until the admin's unban); a transient outage keeps serving within
    // the grace. Activated by the shipped node configuration (node-config.cmd: ENCLAVE_PLATFORM_HOST_POLICY=production). An
    // unmeasured box runs its operator's code, so this is the box's cooperative half; the platform-side gates (relay
    // discovery/attach, routes, custody, management and CLI clients) refuse a banned host regardless of what it runs.
    this.platformPolicy = cfg.platformPolicy ?? createHostServiceGate({ env: process.env, chainId: 8453, book: null,
      hostId: this.enclaveId, stateDir: cfg.dir || null, log: (m) => this.log(m) });"""),
("""    setInterval(() => this.tick().catch((e) => this.log(`tick: ${e.message}`)), TICK_MS);
    setInterval(() => this.heartbeat().catch(() => {}), GAS_CHECK_MS);""",
 """    this.platformPolicy.start();
    setInterval(() => this.tick().catch((e) => this.log(`tick: ${e.message}`)), TICK_MS);
    setInterval(() => this.heartbeat().catch(() => {}), GAS_CHECK_MS);"""),
("""    if (!/^0x[0-9a-f]{64}$/.test(id)) return { accepted: false, reason: "id must be the bytes32 deployment id" };
    if (!this.chainReady) return { accepted: false, reason: `chain unavailable: ${this.lastError}` };""",
 """    if (!/^0x[0-9a-f]{64}$/.test(id)) return { accepted: false, reason: "id must be the bytes32 deployment id" };
    { const pr = this.platformPolicy.newWorkRefusal(); if (pr) return { accepted: false, reason: pr }; }
    if (!this.chainReady) return { accepted: false, reason: `chain unavailable: ${this.lastError}` };"""),
("""      if (rec.boundaryHeld !== true && rec.capHeld !== true && !notServing && !oneQuantum && untilMs - Date.now() < RENEW_LEAD_MS) {""",
 """      if (rec.boundaryHeld !== true && rec.capHeld !== true && !notServing && !oneQuantum && !this.platformPolicy.serviceRefusal() && untilMs - Date.now() < RENEW_LEAD_MS) {"""),
("""  async proxy(id, { method, pathRest, headers, body, ip = null, target = null }) {
    const key = String(id).toLowerCase();""",
 """  async proxy(id, { method, pathRest, headers, body, ip = null, target = null }) {
    const key = String(id).toLowerCase();
    { const pr = this.platformPolicy.serviceRefusal();
      if (pr) return { status: 403, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "host_policy_refused", message: pr })) }; }"""),
])

# ---------------------------------------------------------------- measured direct guest: production activation is measured, not opt-in
edit("metal/guest/measured-control.mjs", [
("""    NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
  };
  return env;""",
 """    NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
    // PLATFORM HOST POLICY: a measured guest on the production chain always enforces it (network/host-service-gate.mjs in
    // supervisor.js), over the owner's measured RPC quorum - the activation is part of the measured image, not an opt-in.
    ENCLAVE_PLATFORM_HOST_POLICY: 'production', ENCLAVE_PLATFORM_HOST_POLICY_RPCS: cfg.rpcs.join(','),
  };
  return env;"""),
])

def edit_all(path, old, new, count):
    p = os.path.join(ROOT, path); s = open(p).read()
    n = s.count(old)
    if n != count: raise SystemExit(f"{path}: anchor found {n} times (want {count}): {old[:100]!r}")
    open(p, "w").write(s.replace(old, new)); done.append(path + f" (x{count})")

# ---------------------------------------------------------------- CLI: host choice, pricing and host operations
edit("cli/enclave.mjs", [
("let INDEPENDENT = null;", """let INDEPENDENT = null;
// PLATFORM HOST POLICY for host choice and host operations (network/platform-host-policy-config.mjs): on for the
// production chain + book (activated by the admin's anchor), read on THIS CLI's own agreed quorum; ENCLAVE_PLATFORM_HOST_POLICY
// overrides. A host it refuses is not listed live, not priced and not contacted for management.
let _hostPolicy;
async function independentHostPolicy() {
  if (_hostPolicy !== undefined) return _hostPolicy;
  const { createHostPolicyRuntime, resolveHostPolicyConfig, clientSnapshot } = await import("../network/host-policy-runtime.mjs");
  const r = resolveHostPolicyConfig({ env, chainId: INDEPENDENT.chain.chainId, book: env.ENCLAVE_ADDRESS_BOOK !== undefined ? env.ENCLAVE_ADDRESS_BOOK : DEFAULTS.ADDRESS_BOOK_ADDRESS });
  _hostPolicy = r.on ? createHostPolicyRuntime(r, { snapshot: clientSnapshot((fn) => INDEPENDENT.chain.snapshot(fn).then((x) => x.value)), log: (m) => trace(m) }) : null;
  return _hostPolicy;
}
// -> null (off) | { [registry id]: decision }; an unreadable policy refuses every host (never lists a banned one as live)
async function hostPolicyDecisions(ids) {
  const rt = await independentHostPolicy();
  if (!rt) return null;
  try { return await rt.admissions(ids.map((i) => String(i).toLowerCase())); }
  catch (e) { return Object.fromEntries(ids.map((i) => [String(i).toLowerCase(), { admit: false, status: "unreadable", reason: `platform host policy unreadable: ${e.message}` }])); }
}
async function policyAdmitted(hosts) {
  const d = await hostPolicyDecisions(hosts.map((h) => h.id));
  return d ? hosts.filter((h) => d[String(h.id).toLowerCase()]?.admit === true) : hosts;
}
async function hostPolicyAdmission() {
  const rt = await independentHostPolicy();
  if (!rt) return null;
  const { leaseHostAdmission } = await import("../network/host-policy-adapters.mjs");
  return leaseHostAdmission(rt.gate);
}"""),
("""  const live = new Set(I.liveHosts(reg.hosts, reg.timestamp, { signedUntil: ev.signedUntil }).map((h) => h.id));
  const rows = (f.all ? judged : judged.filter((h) => live.has(h.id))).map((h) => ({ ...h, live: live.has(h.id) }));""",
 """  const live = new Set(I.liveHosts(reg.hosts, reg.timestamp, { signedUntil: ev.signedUntil }).map((h) => h.id));
  const policy = await hostPolicyDecisions(reg.hosts.map((h) => h.id));
  const refusedBy = (h) => (policy && policy[String(h.id).toLowerCase()]?.admit !== true ? (policy[String(h.id).toLowerCase()] || { admit: false, reason: "no decision" }) : null);
  if (policy) for (const h of reg.hosts) if (refusedBy(h)) live.delete(h.id);
  const rows = (f.all ? judged : judged.filter((h) => live.has(h.id))).map((h) => ({ ...h, live: live.has(h.id), ...(policy ? { platformPolicy: refusedBy(h) || policy[String(h.id).toLowerCase()] } : {}) }));"""),
("""    { h: "state", f: (r) => r.live ? livenessLabel(r.liveness) : !r.active ? "inactive" : !(r.cpuPricePerSec6 > 0n) ? "unpriced\"""",
 """    { h: "state", f: (r) => r.platformPolicy && r.platformPolicy.admit !== true ? "refused (platform policy)" : r.live ? livenessLabel(r.liveness) : !r.active ? "inactive" : !(r.cpuPricePerSec6 > 0n) ? "unpriced\""""),
("""  const client = await managementClient({ trust, chain, deploymentId: id, directories, rec,""",
 """  const client = await managementClient({ trust, chain, deploymentId: id, directories, rec, hostAdmission: await hostPolicyAdmission(),"""),
("""    try { r = await nativeAttest({ profileFile: path.resolve(opt.nativeProfile), deploymentId: id, trust: INDEPENDENT.trust, requestPath: f.path || "/" }); }""",
 """    try { r = await nativeAttest({ profileFile: path.resolve(opt.nativeProfile), deploymentId: id, trust: INDEPENDENT.trust, requestPath: f.path || "/", hostAdmission: await hostPolicyAdmission() }); }"""),
])
edit_all("cli/enclave.mjs", "const c = I.cheapestPrices(I.liveHosts(reg.hosts, reg.timestamp, { signedUntil: ev.signedUntil }));",
         "const c = I.cheapestPrices(await policyAdmitted(I.liveHosts(reg.hosts, reg.timestamp, { signedUntil: ev.signedUntil })));", 2)
edit("cli/independent-host.mjs", [
("export async function managementClient({ trust, chain, deploymentId, directories, stateDir, rec, now = Date.now }) {",
 "export async function managementClient({ trust, chain, deploymentId, directories, stateDir, rec, now = Date.now, hostAdmission = null }) {"),
("  return new ManagementClient({ deploymentId, chainId: chain.chainId, authorityPins, directories, stateDir, signer, reader, now });",
 "  return new ManagementClient({ deploymentId, chainId: chain.chainId, authorityPins, directories, stateDir, signer, reader, now, hostAdmission });"),
("export async function nativeAttest({ profileFile, deploymentId, trust, requestPath = \"/\" }) {",
 "export async function nativeAttest({ profileFile, deploymentId, trust, requestPath = \"/\", hostAdmission = null }) {"),
("  const client = new NativeClient(profile);", "  const client = new NativeClient(profile, { hostAdmission });"),
])
edit("network/native-client.mjs", [
("  constructor(profile,{reader,fetch=globalThis.fetch,probe=probeGuest,now=Date.now,maxConcurrent=4}={}){",
 "  // hostAdmission: the platform host policy for the route's lease host (network/host-policy-adapters.mjs leaseHostAdmission)\n  constructor(profile,{reader,fetch=globalThis.fetch,probe=probeGuest,now=Date.now,maxConcurrent=4,hostAdmission=null}={}){"),
("checkers:p.checkers,now,", "checkers:p.checkers,now,hostAdmission,"),
])
edit("windows/node/node-config.example.cmd", [
("rem set PUBLIC_URL=https://api.enclave.host/t/my-gaming-pc",
 "rem set PUBLIC_URL=https://api.enclave.host/t/my-gaming-pc\nrem The platform host policy (admin host bans): production = on, activated by the admin's anchor. Keep it.\nset ENCLAVE_PLATFORM_HOST_POLICY=production"),
])

print("\n".join(done))
for x in skipped: print("SKIPPED (already integrated):", x)
