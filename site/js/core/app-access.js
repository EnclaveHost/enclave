/* ============================================================
   Private-app browser access from an OWNER-SELECTED frontend
   (work/private-browser-access-interface.txt).

   A private app's sign-in bounce goes to the sign-in pages its
   owner put in the deployment-options envelope (`access.frontends`,
   written only by the owner's setConfig). This module is what such
   a frontend runs. Nothing here talks to enclave.host or Enclave's
   API:

     1. an AGREED read of the deployment's lease (independent-chain):
        active, a current runner whose registry entry is live and
        operated by the lease's operator, and the owner is this wallet
        or its session vault;
     2. the Enclave administrator's platform host policy admits that
        runner (a ban refuses here, before anything is signed);
     3. the app origin is the runner's REGISTRY endpoint (its own
        PUBLIC_URL) + /x/<id>, an https origin that is never an Enclave
        dashboard or API name;
     4. this browser's session signs ONE EnclaveSession authorization
        for EXACTLY POST <that host>/x/<id>/__enclave/session?d=<id>;
     5. the browser goes there with the authorization in the FRAGMENT
        (no server log, no Referer). The host checks the session
        against the chain and its own bases, and sets the app cookie.

   A host that registered a different endpoint than it serves gains
   nothing: the signature names the endpoint's host, and the genuine
   supervisor accepts only its own bases. Every refusal is explicit
   and retryable; there is no fallback to another origin.
   ============================================================ */
import { INDEPENDENT } from "./config.js";

const ID = /^0x[0-9a-f]{64}$/;
export const MAX_FRONTENDS = 4;
const lower = (a) => String(a || "").toLowerCase();

export class AppAccessError extends Error {
  /** kind: chain | stopped | no-host | registry | policy | owner | session | scope | endpoint | public */
  constructor(message, { kind = "refused" } = {}){ super(message); this.name = "AppAccessError"; this.kind = kind; }
}
const fail = (m, kind) => new AppAccessError(m, { kind });

/* ---- the envelope's `access` namespace (the supervisor's parseAccess, mirrored) ---- */
const DNS = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** An exact sign-in origin: https://<lowercase DNS name>[:port], or http://127.0.0.1|[::1]|localhost:<port>. */
export function validFrontend(x){
  if (typeof x !== "string" || x.length > 300) return false;
  const m = /^(https?):\/\/(\[::1\]|[^/:?#@[\]]+)(?::([1-9][0-9]{0,4}))?$/.exec(x);
  if (!m || (m[3] && +m[3] > 65535)) return false;
  const loop = m[2] === "127.0.0.1" || m[2] === "[::1]" || m[2] === "localhost";
  if (m[1] === "http") return loop && !!m[3];
  return !loop && DNS.test(m[2]) && /[a-z]/.test(m[2].split(".").at(-1));
}
function envelopeOf(raw){
  const e = JSON.parse(String(raw || "").trim() || "{}");
  if (!e || Array.isArray(e) || typeof e !== "object") throw new Error("Invalid deployment options.");
  return e;
}
/** The owner's sign-in frontends in an envelope ([] = none chosen: the host's default sign-in applies). Throws on a
 *  malformed namespace, exactly as a runner refuses it. */
export function accessFrontends(raw){
  const e = envelopeOf(raw);
  if (!("access" in e)) return [];
  const a = e.access;
  if (!a || Array.isArray(a) || typeof a !== "object" || Object.keys(a).some((k) => k !== "frontends") || !Array.isArray(a.frontends) ||
      a.frontends.length < 1 || a.frontends.length > MAX_FRONTENDS || !a.frontends.every(validFrontend) || new Set(a.frontends).size !== a.frontends.length)
    throw new Error("Invalid sign-in frontends in the deployment options.");
  return [...a.frontends];
}
/** The envelope with its `access` namespace set to `frontends` (empty = removed). Every other namespace is kept byte for
 *  byte in meaning; a malformed current envelope is refused rather than overwritten. */
export function withAccessFrontends(raw, frontends, cap = 4096){
  accessFrontends(raw);                                   // never silently replace a namespace this page cannot read
  const e = envelopeOf(raw);
  const list = (frontends || []).map((x) => String(x).trim()).filter(Boolean);
  if (list.length > MAX_FRONTENDS) throw new Error(`At most ${MAX_FRONTENDS} sign-in frontends.`);
  for (const x of list) if (!validFrontend(x)) throw new Error(`${JSON.stringify(x)} is not an exact origin (https://name[:port], no path).`);
  if (new Set(list).size !== list.length) throw new Error("A sign-in frontend is listed twice.");
  if (list.length) e.access = { frontends: list }; else delete e.access;
  const text = JSON.stringify(e);
  if (new TextEncoder().encode(text).length > cap) throw new Error(`Deployment options exceed this ledger's ${cap}-byte limit.`);
  return text;
}

/* ---- the app origin and the exact hand-off target ---- */
// Enclave's own dashboard and API front doors are not app hosts: a hand-off is never aimed at them.
const ENCLAVE_NAMES = /(^|\.)(enclave|nan)\.host$/;
/** -> { origin, root, hostPath, sessionUrl } for deployment `id` on a runner whose registry endpoint is `endpoint`. */
export function handoffTarget(endpoint, id){
  if (!ID.test(id || "")) throw fail("a full lower-case deployment id is required", "endpoint");
  let u;
  try { u = new URL(String(endpoint || "")); } catch { throw fail("The host's registered endpoint is not a URL, so this app has no browser address.", "endpoint"); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash)
    throw fail("The host's registered endpoint is not a plain https origin, so this app has no browser address. Use the native client.", "endpoint");
  if (ENCLAVE_NAMES.test(u.hostname))
    throw fail(`This host is reachable only through Enclave's own name (${u.hostname}), which this sign-in page does not use. Open the app from Enclave's dashboard, or use the native client.`, "endpoint");
  const path = u.pathname.replace(/\/+$/, "");
  const root = path + "/x/" + id;
  const hostPath = u.host + root + "/__enclave/session?d=" + id;
  return { origin: u.origin, root, hostPath, sessionUrl: "https://" + hostPath };
}
/** The path the user asked for, kept only if it resolves inside the app (authorize.js wantedPath's rule). */
export function wantedPath(p, origin){
  try {
    const base = new URL(origin), u = new URL(String(p || "/"), base);
    return u.origin === base.origin ? u.pathname + u.search : "/";
  } catch { return "/"; }
}

/* ---- dependencies (tests inject; the page loads the real ones) ---- */
let _deps = null;
export function _useForTests(deps){ _deps = deps; }
async function deps(){
  if (_deps) return _deps;
  const IC = await import("./independent-chain.js");
  const S = await import("./sessions.js");
  const { Enclave } = await import("./api.js");
  const IDN = await import("./identity.js");
  const IM = await import("./independent-management.js");
  return { agreedLease: IC.agreedLease, leaseHostPolicy: IC.leaseHostPolicy, session: () => S.currentSession(), actions: async () => (await S.sdk()).ACTIONS,
           wallet: () => Enclave.address, owner: () => IDN.actingOwner(Enclave.address), checkAuthorization: async (...a) => (await IM.transport()).checkAuthorizationWeb(...a) };
}

/**
 * Prepare the navigation that opens private deployment `id` as its owner. -> { url, origin, root, runner, block } where
 * `url` carries the session authorization in its fragment. A PUBLIC deployment needs none: { url, public: true }.
 * Throws AppAccessError; nothing was sent anywhere (only chain reads happened).
 */
export async function openPrivateApp(id, { path = "/" } = {}){
  if (!ID.test(id || "")) throw fail("a full lower-case deployment id is required", "endpoint");
  if (!_deps && INDEPENDENT.state !== "on") throw fail("independent mode is not active in this tab", "chain");
  const D = await deps();
  let lr;
  try { lr = await D.agreedLease(id); }
  catch (e){ throw fail("The chain endpoints did not agree on this deployment's lease (" + String(e.message || e).slice(0, 160) + "). Nothing was signed.", "chain"); }
  const { lease } = lr;
  if (!lease.active) throw fail("This deployment is stopped on the ledger, so there is nothing to open.", "stopped");
  if (/^0x0{64}$/.test(lease.runner) || !(lease.leaseUntil > Date.now()))
    throw fail("No host holds a current lease for this deployment, so it is not running anywhere right now.", "no-host");
  if (!lr.current || !lr.host)
    throw fail("The host's registry entry is inactive or names another operator, so its address is not trusted. Nothing was signed.", "registry");
  // the Enclave administrator's platform host policy: a host it does not admit is never sent anything
  const pol = await D.leaseHostPolicy(lease);
  if (!pol || pol.admit !== true)
    throw fail("The platform host policy refuses this deployment's host: " + ((pol && pol.reason) || "no decision") + ". Nothing was signed.", "policy");
  const target = handoffTarget(lr.host.endpoint, id);
  const want = wantedPath(path, target.origin);
  if (lease.isPublic) return { url: target.origin + target.root + want, public: true, origin: target.origin, runner: lease.runner, block: lease.blockNumber };
  const c = await D.session().catch(() => null);
  const who = lower(D.owner ? D.owner() : D.wallet());
  if (!who) throw fail("Connect the wallet that owns this app first.", "owner");
  if (!c || !c.session || !c.session.handle)
    throw fail("Opening a private app from this page is signed by a session: start one on the Sessions page first. Nothing was signed.", "session");
  if (lower(c.owner) !== who) throw fail("This browser's session belongs to another wallet. Nothing was signed.", "session");
  const vault = lower(c.session.handle.vault);
  if (lease.owner !== who && lease.owner !== vault)
    throw fail(`This app's current owner is ${lease.owner} (read at block ${lease.blockNumber}), not this wallet or its session vault.`, "owner");
  const st = await c.session.status().catch(() => null);
  if (st && (!st.live || Number(st.expiresAt) <= Math.floor(Date.now() / 1000)))
    throw fail("This browser's session has ended. Start a new one on the Sessions page.", "session");
  const bit = (await D.actions())["api.appAccess"];
  if (bit == null || (st && ((BigInt(st.actions) >> BigInt(bit)) & 1n) !== 1n))
    throw fail("This browser's session does not allow opening apps (api.appAccess). Start a session that does.", "scope");
  const empty = new Uint8Array(0);
  const authorization = await c.session.apiAuthorization("POST", target.sessionUrl, empty);
  // the signer must have signed exactly this request (the host checks it again, against its own bases)
  try { await D.checkAuthorization(authorization, { method: "POST", hostPath: target.hostPath, body: empty }); }
  catch (e){ throw fail("This browser's session signer did not sign exactly this hand-off (" + String(e.message || e).slice(0, 120) + "). Nothing was sent.", "session"); }
  return { url: target.sessionUrl + "#a=" + encodeURIComponent(authorization) + "&p=" + encodeURIComponent(want),
           origin: target.origin, root: target.root, runner: lease.runner, block: lease.blockNumber };
}
