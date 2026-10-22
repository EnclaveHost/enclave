/* ============================================================
   Host management from the independent dashboard: status, logs,
   host-reported attestation, restart, the private-app token and CPU
   profiling, over the browser transport a host operator may publish
   (network/management-browser.mjs, vendored as /vendor/management.js
   by scripts/build-management-vendor.mjs; the contract is
   work/management-interface.txt).

   Each operation, every time:
   1. LEASE. The deployment's row and its runner's registry entry are read
      at ONE block the profile's RPCs agree on (independent-chain.js
      agreedLease). A single RPC, a directory or an older read never
      decides who runs it. The current owner must be this wallet or this
      browser's session vault; otherwise nothing is sent.
   2. RECORD. Every management record the profile's directories hold is an
      untrusted copy. Only one signed by the lease's CURRENT runner operator,
      for this runner, chain and ledger, counts; the newest sequence wins and
      a persistent floor ({sequence, hash} per network and runner, the native
      client's key) refuses a replayed older record or an equivocation. The
      floor is saved before the origin is used.
   3. ORIGIN. The record's browser origin, only when the operator listed this
      page's exact origin among its dashboards. No record, no browser
      transport, or an unlisted origin: nothing is sent, and the native
      client command is shown instead.
   4. SIGNATURE. This browser's session key (non-extractable WebCrypto P-256,
      IndexedDB) signs exactly this method, runner management base, path and
      body; the helper re-checks that signature with WebCrypto before sending.
   5. ONE REQUEST, never retried: no redirect, no credentials, no cookies.
      A mutation (restart, CPU profile start/stop) whose answer is lost or
      malformed is reported as "outcome unknown: check status" - the page
      never resends it.

   TRUST, as the UI states it: the browser checked the WebPKI certificate of
   an origin the current runner operator signed. It did NOT check the host's
   TLS key (SPKI) and it depends on DNS and a public CA. The native client
   pins the exact SPKI over a literal IP and keeps working when DNS or the CA
   path fails. Host answers (status, attestation) are host-reported; nothing
   here calls them verified.

   The app token is returned to the caller only. It is never logged, never
   written to localStorage, sessionStorage or IndexedDB, and never put in an
   error message.
   ============================================================ */
import { INDEPENDENT, DEPLOYMENTS_ADDRESS, REGISTRY_ADDRESS } from "./config.js";

const FLOOR_PREFIX = "enclave_mgmt_floor:";
const ID = /^0x[0-9a-f]{64}$/;
const MAX_RECORDS_BYTES = 4 << 20;
export const TRANSPORT_NOTE = "Your browser checked the WebPKI certificate of an origin that this deployment's current host operator signed. "
  + "It did not check the host's TLS key (SPKI), and it depends on DNS and a public certificate authority. "
  + "The native client pins the exact SPKI over a literal IP and keeps working when DNS or the CA path fails.";
export const HOST_REPORTED_NOTE = "Host-reported, not verified: this page shows what the host says. Verify the app's own SEV-SNP guest with the native client.";

let _mod = null;
/** The vendored transport (one same-origin bundle, loaded on first use). */
export function transport(){
  return _mod ||= import("/vendor/management.js").catch((e) => { _mod = null; throw new ManagementUiError("Could not load the management client: " + (e.message || e), { kind: "unavailable" }); });
}
let _deps = null;
/** Tests only: stand in for the vendored transport, the lease reader and the session (Node cannot load /vendor). */
export function _useForTests({ mod, deps } = {}){ if (mod) _mod = Promise.resolve(mod); if (deps !== undefined) _deps = deps; }

/** Every refusal or failure the panel shows. kind: 'refused' (nothing happened), 'unknown' (a mutation may have run),
 *  'unreachable' (a read could not reach the origin), 'no-transport' (use the native client), 'chain' (no agreed read),
 *  'busy' (the gateway's own limits refused before forwarding: try again shortly), 'delegation' (a wallet-held deployment
 *  the owner has not delegated to the session vault on the ledger), 'no-gpu' (the host reports no GPU). */
export class ManagementUiError extends Error {
  constructor(message, { kind = "refused", status = null, code = null, sent = false, outcomeUnknown = false, native = null } = {}){
    super(message); this.name = "ManagementUiError"; Object.assign(this, { kind, status, code, sent, outcomeUnknown, native });
  }
}

/* ---- the persistent rollback floor (localStorage: it must outlive the tab, as the native client's stateDir does) ----
   The helper owns the floor: a composite {version: 1, operators: {<operator>: {sequence, hash}}} (one rollback floor per
   operator of the runner, so a former operator's records can never raise the floor a new operator is judged against),
   stored under managementFloorKey and passed back as returned. This page only refuses to move it backwards: a write merges
   with what is stored (another tab may have saved a newer floor meanwhile), keeping the higher sequence per operator. A
   legacy single {sequence, hash} floor is not honored by the helper and is not kept. */
const ENTRY = (f) => !!f && typeof f === "object" && Number.isSafeInteger(f.sequence) && f.sequence >= 1 && /^[0-9a-f]{64}$/.test(f.hash || "");
const COMPOSITE = (f) => !!f && typeof f === "object" && f.version === 1 && f.operators && typeof f.operators === "object" && !Array.isArray(f.operators)
  && Object.entries(f.operators).every(([k, v]) => /^0x[0-9a-f]{40}$/.test(k) && ENTRY(v));
const MAX_FLOOR_BYTES = 16384;
function storage(){ try { return globalThis.localStorage || null; } catch { return null; } }
export function loadFloor(key, ls = storage()){
  try {
    const f = JSON.parse((ls && ls.getItem(FLOOR_PREFIX + key)) || "null");
    return COMPOSITE(f) ? { version: 1, operators: Object.fromEntries(Object.entries(f.operators).map(([k, v]) => [k, { sequence: v.sequence, hash: v.hash }])) } : null;
  } catch { return null; }
}
const later = (a, b) => (!a ? b : !b ? a : b.sequence > a.sequence ? b : a);
export function mergeFloors(stored, next){
  if (!COMPOSITE(next)) return stored;
  if (!COMPOSITE(stored)) return next;
  const operators = { ...stored.operators };
  for (const [k, v] of Object.entries(next.operators)) operators[k] = later(operators[k], v);
  return { version: 1, operators };
}
/* forward only: an older floor never replaces a newer one, even from another tab */
export function saveFloor(key, floor, ls = storage()){
  if (!floor || !ls) return;
  const merged = mergeFloors(loadFloor(key, ls), floor);
  const text = JSON.stringify(merged);
  if (!merged || text.length > MAX_FLOOR_BYTES) return;
  ls.setItem(FLOOR_PREFIX + key, text);
}

/* The directories this page uses (profile + chosen index operators), split by whether this page can reach them. */
export async function pageDirectoryOrigins(){
  const SD = await import("./service-discovery.js");
  let disc = null;
  if (INDEPENDENT.profile.serviceIndex){
    try { disc = await SD.discover({ profile: INDEPENDENT.profile, reader: (await import("./independent-chain.js")).reader() }); } catch { disc = null; }
  }
  const all = SD.pageDirectories(INDEPENDENT.profile, disc);
  return { reachable: all.filter((d) => d.reachable).map((d) => d.origin), unreachable: all.filter((d) => !d.reachable), all };
}

/* ---- records: every directory's copy, untrusted ---- */
async function directoryRecords(directories, fetchImpl){
  const got = await Promise.allSettled(directories.map(async (d) => {
    const r = await fetchImpl(String(d).replace(/\/+$/, "") + "/v1/network/records", { credentials: "omit", redirect: "error", cache: "no-store",
      referrerPolicy: "no-referrer", signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    if (text.length > MAX_RECORDS_BYTES) throw new Error("directory snapshot too large");
    const j = JSON.parse(text);
    return Array.isArray(j && j.management) ? j.management : [];
  }));
  return { envelopes: got.filter((x) => x.status === "fulfilled").flatMap((x) => x.value),
           answered: got.filter((x) => x.status === "fulfilled").length, failed: got.filter((x) => x.status === "rejected").length };
}

/* ---- the native fallback: the CLI's ManagementClient (exact SPKI over a literal IP, no DNS or CA) ---- */
const LITERAL_IP = /^https?:\/\/(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i;
export function nativeCommands(id, op){
  const p = INDEPENDENT.profile || {};
  const dirs = (p.directories || []).filter((d) => LITERAL_IP.test(d));
  const flagsBase = "enclave --independent --profile network-profile.json --profile-digest sha256:<published fingerprint> --rpc " + (p.rpcs || []).join(",");
  const where = " --directories " + (dirs.length ? dirs.join(",") : "<literal-IP directory origins>");
  const cmd = {
    status: `status ${id} --host` + where,
    logs: `logs ${id} --tail 200` + where,
    attestation: `attest ${id} --native-profile base-profile.json`,
    restart: `restart ${id}` + where,
    appToken: `app-token ${id} --out app-token.txt` + where,
    cpuProfile: `cpu-profile get ${id} --out profile.prof` + where,
    cpuProfileControl: `cpu-profile start ${id} --seconds 10` + where,
    gpu: `status ${id} --host` + where,          // no independent `enclave gpu` yet: see the note below
  }[op] || `status ${id} --host` + where;
  return { command: flagsBase + " " + cmd,
    notes: ["The native client uses a session of its own (enclave --independent session new --preset browser); this browser's session key cannot leave the browser.",
      "It reads the same operator-signed record but dials its literal IP and pins its TLS key (SPKI), so it needs no DNS name or public CA.",
      ...(dirs.length ? [] : ["The native client reads records only from literal-IP directory origins; this profile names none, so supply them."]),
      ...(op === "gpu" ? ["The CLI has no independent-mode GPU command yet; the native read is ManagementClient.gpu() in network/management-client.mjs (same operator-signed record, pinned SPKI)."] : []),
      ...(op === "attestation" ? ["enclave attest --native-profile verifies the app's own SEV-SNP guest (base-profile.json is the Connect tab's starting profile)."] : [])] };
}

async function deps(){
  if (_deps) return _deps;
  const IC = await import("./independent-chain.js");
  const S = await import("./sessions.js");
  const { Enclave } = await import("./api.js");
  const ID = await import("./identity.js");
  // owner(): whom the dashboard acts for - the wallet, or a verified passkey account (never the wallet paying its gas)
  return { agreedLease: IC.agreedLease, session: () => S.currentSession(), sdk: () => S.sdk(), wallet: () => Enclave.address,
           owner: () => ID.actingOwner(Enclave.address),
           origin: () => globalThis.location.origin, fetch: (...a) => globalThis.fetch(...a) };
}

const lower = (a) => String(a || "").toLowerCase();
const fail = (message, opts) => new ManagementUiError(message, opts);

/**
 * Resolve the current runner's browser endpoint for `id` (steps 1-3 above). -> { endpoint, lease, record, origin, session,
 * block }. Throws ManagementUiError; kind 'no-transport' and 'chain' carry the native command.
 */
export async function resolveEndpoint(id, op = "status"){
  if (!ID.test(id || "")) throw fail("a full lower-case deployment id is required");
  if (INDEPENDENT.state !== "on") throw fail("independent mode is not active in this tab");
  const D = await deps();
  const native = nativeCommands(id, op);
  let lr;
  try { lr = await D.agreedLease(id); }
  catch (e){ throw fail("The chain endpoints did not agree on this deployment's lease (" + String(e.message || e).slice(0, 160) + "). Nothing was sent.", { kind: "chain", native }); }
  const { lease } = lr;
  // the session that will sign, and the owners it speaks for
  const c = await D.session().catch(() => null);
  const wallet = lower(D.owner ? D.owner() : D.wallet());     // the acting owner: the wallet, or a verified passkey account
  const acct = !!D.owner && wallet !== lower(D.wallet());
  if (!wallet) throw fail("Your dashboard identity is not verified, so nothing can be signed for it. Nothing was sent.", { native });
  if (!c || !c.session || !c.session.handle) throw fail("Host management is signed by a session: start one (" + (acct ? "Account" : "Wallet") + " session → Start) first. Nothing was sent.", { native });
  if (lower(c.owner) !== wallet) throw fail("This browser's session belongs to another " + (acct ? "owner" : "wallet") + ". Nothing was sent.", { native });
  const vault = lower(c.session.handle.vault);
  if (lease.owner !== wallet && lease.owner !== vault)
    throw fail(`This deployment's current owner is ${lease.owner} (read at block ${lease.blockNumber}), not ${acct ? "your passkey account" : "this wallet"} or its session vault. Nothing was sent.`, { native });
  if (!lease.active) throw fail("This deployment is stopped on the ledger. Nothing was sent.", { native });
  if (/^0x0{64}$/.test(lease.runner) || !(lease.leaseUntil > Date.now()))
    throw fail("No host holds a current lease for this deployment, so there is no host to manage. Nothing was sent.", { native });
  if (!lr.current) throw fail("The runner's registry entry is inactive or names another operator, so its management records are not trusted. Nothing was sent.", { native });
  // the profile's directories plus the directory operators the user chose from the service index (js/core/service-discovery.js);
  // a directory this page cannot reach (plain HTTP from an HTTPS page) is named, never silently treated as answering
  const page = await pageDirectoryOrigins();
  const dirs = page.reachable;
  if (!dirs.length) throw fail(page.unreachable.length
    ? "No directory this page can reach holds management records: " + page.unreachable.map((d) => d.origin + " (" + d.reason + ")").join("; ") + "."
    : "The network profile names no directories and none was chosen from the service index, so the host's management record cannot be found from this page.", { kind: "no-transport", native });
  const M = await transport();
  const rec = await directoryRecords(dirs, D.fetch);
  if (!rec.answered) throw fail("None of the profile's directories answered, so the host's management record cannot be read from this page.", { kind: "no-transport", native });
  const net = { chainId: INDEPENDENT.profile.chainId, deployments: lower(DEPLOYMENTS_ADDRESS), registry: lower(REGISTRY_ADDRESS) };
  // one key per runner and network (the native client's); the floor stored under it is per operator
  const key = M.managementFloorKey({ ...net, runner: lease.runner });
  let ep;
  try { ep = await M.browserManagementEndpoint(rec.envelopes, lease, { ...net, dashboardOrigin: D.origin(), floor: loadFloor(key) }); }
  catch (e){
    if (e && e.floor) saveFloor(key, e.floor);
    const m = String(e.message || e);
    throw fail(/no browser transport|withdrew|not one the runner operator allowed|no current management record/.test(m)
      ? m.charAt(0).toUpperCase() + m.slice(1) + ". Use the native client." : "The host's management record was refused: " + m + ". Nothing was sent.",
      { kind: "no-transport", native });
  }
  saveFloor(key, ep.floor);                  // before the origin is used
  // the only origin this page will send to is the one inside the operator's signature
  if (!ep.record || ep.record.version !== 2 || !ep.record.browser || ep.origin !== ep.record.browser.origin)
    throw fail("The management endpoint does not match its signed record. Nothing was sent.", { kind: "no-transport", native });
  // ep is passed to the request exactly as the helper returned it: it carries the signed envelope the request re-verifies
  return { endpoint: ep, lease, record: ep.record, origin: ep.origin, session: c, block: lr.snap.number, native, walletHeld: lease.owner === wallet };
}

/* The request signer: this browser's session key over exactly { method, hostPath, body }, after the session's own on-chain
   state shows it live with this operation's scope (the gateway decides again from its own agreed read). */
async function signerFor(r, scope){
  const S = await (_deps ? _deps.sdk() : (await import("./sessions.js")).sdk());
  // best effort: an unreadable status is left to the gateway, which decides from its own agreed read
  const st = await r.session.session.status().catch(() => null);
  if (st && (!st.live || Number(st.expiresAt) <= Math.floor(Date.now() / 1000))) throw fail("This browser's wallet session has ended. Start a new one. Nothing was sent.", { native: r.native });
  const bit = S.ACTIONS[scope];
  if (bit == null || (st && ((BigInt(st.actions) >> BigInt(bit)) & 1n) !== 1n)) throw fail(`This browser's session does not allow ${scope}. Nothing was sent.`, { native: r.native });
  return ({ method, hostPath, body }) => r.session.session.apiAuthorization(method, "https://" + hostPath, body);
}

const SCOPE = { status: "api.status", attestation: "api.status", logs: "api.logs", restart: "api.restart", appToken: "api.appAccess",
                cpuProfile: "api.logs", cpuProfileControl: "api.logs", gpu: "api.status" };

/**
 * One management operation, exactly once. -> { result, trust } where trust names the transport, origin, operator, record
 * sequence and the agreed block. Throws ManagementUiError (never retried; outcomeUnknown on a mutation = check status).
 */
export async function manage(id, op, opts = {}){
  if (!SCOPE[op]) throw fail("unsupported management operation");
  const r = await resolveEndpoint(id, op);
  const M = await transport();
  const signer = await signerFor(r, SCOPE[op]);
  const D = await deps();
  try {
    const result = await M.browserManagementRequest({ op, deploymentId: id, endpoint: r.endpoint, lease: r.lease, signer, fetch: D.fetch, ...opts });
    return { result, trust: trustOf(r, result) };
  } catch (e){
    const msg = String((e && e.message) || e).replace(/[A-Za-z0-9_-]{120,}/g, "…");     // never echo a long opaque value
    if (e && e.outcomeUnknown) throw fail(/check status/.test(msg) ? msg : msg + ": check status before asking again",
      { kind: "unknown", status: e.status ?? null, code: e.code ?? null, sent: e.sent ?? null, outcomeUnknown: true, native: r.native });
    // the gateway's own load and replay limits refuse before forwarding (x-enclave-management-forwarded: 0): nothing ran
    if (e && ["busy", "rate_limited", "replay_capacity"].includes(e.code))
      throw fail(msg + ". The host is busy and did nothing; try again shortly.", { kind: "busy", status: e.status, code: e.code, sent: true, native: r.native });
    // a CPU-only host answers the GPU read with no_gpu: a fact about the host, not a failure of this page
    if (e && e.code === "no_gpu") throw fail("This deployment's host reports no GPU (a CPU-only host).", { kind: "no-gpu", status: e.status, code: e.code, sent: true, native: r.native });
    if (e && /delegat/.test(msg) && r.walletHeld)
      throw fail(msg, { kind: "delegation", status: e.status, code: e.code, sent: true, native: r.native });
    if (e && e.sent === null) throw fail(msg + ` (${r.origin}). If its DNS name or certificate fails, use the native client.`, { kind: "unreachable", sent: null, native: r.native });
    throw fail(msg, { kind: "refused", status: e && e.status, code: e && e.code, sent: !!(e && e.sent), native: r.native });
  }
}
function trustOf(r, result){
  return { transport: result.transport, origin: r.origin, operator: r.record.operator, sequence: r.record.sequence, runner: r.lease.runner,
           block: r.block, forwarded: result.forwarded, note: TRANSPORT_NOTE };
}

/* ---- the operations the dashboard (and api.js in independent mode) uses ---- */
export const hostStatus = (id) => manage(id, "status");
export const hostLogs = (id, tail = 200) => manage(id, "logs", { tail: Math.max(1, Math.min(2000, Number(tail) || 200)) });
/* A fresh 32-byte nonce from this page. The answer stays host-reported whatever it echoes. */
export async function hostAttestation(id){
  const n = new Uint8Array(32); globalThis.crypto.getRandomValues(n);
  const nonce = [...n].map((b) => b.toString(16).padStart(2, "0")).join("");
  const out = await manage(id, "attestation", { nonce });
  return { ...out, nonce, echoesNonce: JSON.stringify(out.result.json || {}).includes(nonce), verified: false };
}
export const hostRestart = (id) => manage(id, "restart");
export const hostAppToken = (id) => manage(id, "appToken");
/* The host's GPU state for the deployment's current runner (the supervisor's own /v1/gpu view: MPS, SM split, tenants,
   VRAM). HOST-REPORTED: not attestation, not a capacity reservation - free capacity can change before any claim. */
export const hostGpu = (id) => manage(id, "gpu");
export const hostCpuProfile = (id) => manage(id, "cpuProfile");
export function hostCpuProfileControl(id, { action, seconds } = {}){
  return manage(id, "cpuProfileControl", action === "start" ? { action, seconds: Number(seconds) } : { action: "stop" });
}
/* What the panel shows for a GPU answer (the supervisor's /v1/gpu view), as plain rows. Every value is what the host
   says. Shield hosts add per-card fields from the card's own proof record; they are listed as host-reported claims,
   never as verified evidence - this page checks none of them. */
const pct = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x) * 100) + "%" : null);
export function gpuView(j){
  j = j && typeof j === "object" ? j : {};
  const rows = [];
  const add = (k, v) => { if (v != null && v !== "") rows.push([k, String(v)]); };
  add("role", j.role);
  if (j.role === "shielded"){
    const cards = Array.isArray(j.cards) ? j.cards : [];
    add("cards", cards.length);
    if (j.pool && typeof j.pool === "object") add("pool", JSON.stringify(j.pool));
    const known = new Set(["id", "available", "vramBudgetGb", "vramLedgerFreeGb", "vramFreeGb", "gpuShareFree"]);
    return { headline: "Enclave Shield GPU host", rows,
      cards: cards.map((c) => ({ id: String(c.id ?? "?"), available: !!c.available, vramFreeGb: c.vramFreeGb ?? null, vramBudgetGb: c.vramBudgetGb ?? null,
        shareFree: pct(c.gpuShareFree), claims: Object.keys(c).filter((k) => !known.has(k)).sort() })),
      tenants: [], note: HOST_GPU_NOTE };
  }
  const c = j.capacity && typeof j.capacity === "object" ? j.capacity : {};
  add("MPS", j.mpsActive == null ? null : j.mpsActive ? "active" : "off");
  add("SMs (total)", j.smTotal);
  add("free share", pct(c.gpuShareFree));
  add("free VRAM (GB)", c.vramFreeGb);
  add("free SMs", c.smFree);
  if (j.vm && typeof j.vm === "object"){
    add("VM apps", j.vm.apps);
    add("VRAM committed / budget (GB)", j.vm.vramCommittedGb != null && j.vm.vramBudgetGb != null ? j.vm.vramCommittedGb + " / " + j.vm.vramBudgetGb : null);
    add("VRAM divergence (GB)", j.vm.vramDivergenceGb);
  }
  return { headline: "GPU host", rows, cards: [],
    tenants: (Array.isArray(j.tenants) ? j.tenants : []).map((t) => ({ pct: t.pct, status: String(t.status ?? ""), sms: t.smGranted ?? null })),
    note: HOST_GPU_NOTE };
}
export const HOST_GPU_NOTE = "Host-reported GPU state: what the host says right now. It is not attestation and not a capacity reservation; "
  + "free capacity can change before any claim.";

/* A capture's gperftools bytes (base64 in the answer), for a download. */
export function profileBytes(json){
  if (!json || typeof json.data !== "string") return null;
  const t = atob(json.data); return Uint8Array.from(t, (ch) => ch.charCodeAt(0));
}
