// windows/node/waf.mjs -- the per-deployment protection rules, on this box.
//
// The deployment-options envelope's `waf` namespace: a rate limit, a concurrency cap, a body-size
// cap and three filters, all dialled by the DEPLOYMENT's owner and enforced per client address.
//
// MIRRORED FROM THE PLATFORM RUNNER (supervisor.js wafGate / wafPathBlocked / parseOptions),
// deliberately and down to the status codes and the error bodies. The envelope is FAIL-CLOSED: a
// runner that does not know a namespace refuses the whole deployment, so the relay AND-folds `waf`
// across the fleet and the console only offers the controls when every box honours them. A box
// that implemented these rules DIFFERENTLY would be worse than one that refuses them, because the
// same deployment would be protected on one box and open on another with nothing having said so.
//
// WHERE IT RUNS, and what that costs. On the platform this sits inside the CVM, at the one proxy
// every request crosses. Here there are two doors and both are in VTL0: the relay's /x/<id> path
// and the app's own hostname (appzone.mjs). So the rules are enforced by the agent, which already
// carries the request bytes - this adds no exposure that the traffic did not already have, and
// /availability says so (`apps.traffic: "carried by the host"`). What it is NOT is enforcement
// inside the enclave; an app that needs that must do it itself.
//
// State is per-deployment and in memory only: the buckets refill from the wall clock, so a restart
// forgives a burst rather than locking anyone out.

/** Root-anchored prefixes of the paths bulk scanners try. The platform's list, verbatim. */
export const SCANNER_PATHS = [
  "/.env", "/.git", "/.svn", "/.aws", "/.ssh", "/.htaccess", "/.htpasswd",
  "/.ds_store", "/.vscode", "/.idea", "/wp-admin", "/wp-login.php", "/wp-includes",
  "/wp-content", "/xmlrpc.php", "/phpmyadmin", "/phpinfo", "/cgi-bin",
  "/vendor/phpunit", "/server-status", "/actuator", "/web.config", "/appsettings.json",
  "/id_rsa", "/backup.sql", "/dump.sql", "/config.php",
];

export const WAF_KEYS = ["rps", "burst", "maxConcurrent", "maxBodyMb", "methods", "pathBlock", "blockScanners", "uaBlock"];

/**
 * Validate the envelope's `waf` object, or throw the reason.
 *
 * Every bound is the platform's. A value this box accepted but the fleet refused (or the reverse)
 * would make the same envelope valid in one place and invalid in another, which for a fail-closed
 * field means the deployment runs here and is refused there.
 */
export function parseWaf(w) {
  if (!w || Array.isArray(w) || typeof w !== "object") throw new Error("waf must be a JSON object");
  const bad = Object.keys(w).filter((k) => !WAF_KEYS.includes(k));
  if (bad.length) throw new Error(`unknown waf option ${JSON.stringify(bad[0])} (this runner knows: ${WAF_KEYS.join(", ")})`);
  const out = {};
  const num = (k, min, max, int) => {
    if (w[k] == null) return null;
    const v = Number(w[k]);
    if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v)))
      throw new Error(`waf.${k} must be ${int ? "an integer" : "a number"} in [${min}, ${max}]`);
    return v;
  };
  const rps = num("rps", 0.1, 10000);           if (rps != null) out.rps = rps;
  const burst = num("burst", 1, 100000, true);
  if (burst != null) { if (rps == null) throw new Error("waf.burst needs waf.rps"); out.burst = burst; }
  else if (rps != null) out.burst = Math.max(5, Math.ceil(rps * 4));   // default: ~4s of headroom
  const conc = num("maxConcurrent", 1, 10000, true); if (conc != null) out.maxConcurrent = conc;
  const body = num("maxBodyMb", 0.001, 1024);        if (body != null) out.maxBodyMb = body;
  const strs = (k, max, maxLen, check, what) => {
    if (w[k] == null) return null;
    if (!Array.isArray(w[k]) || w[k].length < 1 || w[k].length > max) throw new Error(`waf.${k} must be an array of 1..${max} ${what}`);
    return w[k].map((x) => {
      if (typeof x !== "string" || !x.trim() || x.length > maxLen || !check(x.trim())) throw new Error(`waf.${k} entry ${JSON.stringify(x)} is not ${what}`);
      return x.trim();
    });
  };
  const methods = strs("methods", 10, 10, (x) => /^[A-Za-z]{3,10}$/.test(x), "an HTTP method name");
  if (methods) out.methods = [...new Set(methods.map((m) => m.toUpperCase()))];
  const paths = strs("pathBlock", 64, 200, (x) => x.startsWith("/"), "a path prefix starting with /");
  if (paths) out.pathBlock = [...new Set(paths.map((p) => p.toLowerCase()))];
  // a 1-2 char UA needle would match nearly every agent string - refuse it
  const uas = strs("uaBlock", 32, 100, (x) => x.length >= 3, "a User-Agent substring of 3+ chars");
  if (uas) out.uaBlock = [...new Set(uas.map((u) => u.toLowerCase()))];
  if (w.blockScanners != null) {
    if (typeof w.blockScanners !== "boolean") throw new Error("waf.blockScanners must be a boolean");
    if (w.blockScanners) out.blockScanners = true;
  }
  if (!Object.keys(out).length) throw new Error("waf enables nothing: set at least one of " + WAF_KEYS.join(", "));
  return out;
}

/**
 * Is this app-relative URL blocked by the deployment's path rules?
 *
 * Decoded first, because percent-encoding must not dodge a prefix (`%2e%65nv` is `/.env`), then
 * lowercased with the query stripped and the leading slashes collapsed - `//.env` and `/./env`
 * are the same request to an app.
 */
export function pathBlocked(w, url) {
  let p = String(url || "/").split("?")[0];
  try { p = decodeURIComponent(p); } catch { /* undecodable %-junk: match the raw bytes */ }
  p = ("/" + p.replace(/^\/+/, "")).toLowerCase();
  if (w.blockScanners && SCANNER_PATHS.some((x) => p.startsWith(x))) return true;
  return (w.pathBlock || []).some((x) => p.startsWith(x));
}

/** Per-deployment counters. Nothing here is persisted: a restart forgives a burst. */
const states = new Map();          // id -> { buckets: Map(ip -> {tokens, at}), active: Map(ip -> n) }
export function forget(id) { states.delete(String(id || "").toLowerCase()); }

/**
 * Apply a deployment's rules to one request.
 *
 * Returns null to allow, or { status, error, message, headers } to refuse - the caller answers,
 * because the two doors on this box answer differently (one writes an HTTP response, the other
 * returns a frame). `release()` on an allowed request is what frees a concurrency slot; a caller
 * that forgets it would leak the slot, so it is returned rather than left implicit.
 */
export function check(id, w, { method, url, headers = {}, ip }) {
  if (!w) return null;
  const deny = (status, error, message, headers) => ({ status, error, message, headers });
  if (w.methods && !w.methods.includes(String(method || "GET").toUpperCase()))
    return deny(405, "waf_method", `This deployment's protection rules allow only: ${w.methods.join(", ")}.`);
  if ((w.blockScanners || w.pathBlock) && pathBlocked(w, url))
    return deny(403, "waf_path", "Blocked by this deployment's protection rules.");
  if (w.uaBlock) {
    const ua = String(headers["user-agent"] || "").toLowerCase();
    if (w.uaBlock.some((s) => ua.includes(s)))
      return deny(403, "waf_agent", "Blocked by this deployment's protection rules.");
  }
  // Content-Length fast reject. A chunked or lying body is the caller's to cap as it reads.
  const cl = Number(headers["content-length"]);
  if (w.maxBodyMb && Number.isFinite(cl) && cl > w.maxBodyMb * 1048576)
    return deny(413, "waf_body", `Request body exceeds this deployment's ${w.maxBodyMb} MB limit.`);

  const key = String(id || "").toLowerCase();
  const who = String(ip || "?");
  let st = states.get(key);
  if (!st) { st = { buckets: new Map(), active: new Map() }; states.set(key, st); }
  let release = () => {};
  if (w.maxConcurrent) {
    const n = st.active.get(who) || 0;
    if (n >= w.maxConcurrent)
      return deny(429, "waf_busy", `Too many concurrent requests from your address (limit ${w.maxConcurrent}).`,
                  { "retry-after": "1" });
    st.active.set(who, n + 1);
    let freed = false;
    release = () => {
      if (freed) return;                       // called twice must not credit a slot back twice
      freed = true;
      const m = (st.active.get(who) || 1) - 1;
      m > 0 ? st.active.set(who, m) : st.active.delete(who);
    };
  }
  if (w.rps) {
    const now = Date.now();
    let b = st.buckets.get(who);
    if (!b) { b = { tokens: w.burst, at: now }; st.buckets.set(who, b); }
    b.tokens = Math.min(w.burst, b.tokens + ((now - b.at) / 1000) * w.rps);
    b.at = now;
    if (b.tokens < 1) {
      release();                               // refused: it never occupied the slot it was given
      return deny(429, "waf_rate_limited", `Rate limit: this deployment allows ${w.rps} requests/sec per address (burst ${w.burst}).`,
                  { "retry-after": String(Math.max(1, Math.ceil((1 - b.tokens) / w.rps))) });
    }
    b.tokens -= 1;
  }
  return { allow: true, release };
}

/** The client's address, from the relay's forwarding header or the socket. */
export function clientIp(headers = {}, socket = null) {
  const xs = String(headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
  return xs[xs.length - 1] || socket?.remoteAddress || "?";
}
