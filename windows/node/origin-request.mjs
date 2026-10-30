// windows/node/origin-request.mjs -- one HTTP(S) request to ONE origin, over whichever of that origin's own resolved
// addresses completes a verified connection.
//
// WHY THIS EXISTS. api.enclave.host resolves to several front addresses, and the node's fetch() connects to the first
// one only. On 2026-10-23 two fronts completed TCP and then closed the TLS handshake, and the NucBox's resolver put one
// of them first: every certificate pickup (apptls.requestCert) and every secrets-state read (secrets.mjs) failed with
// ECONNRESET while the other fronts were healthy, so certificates the relay had already issued were never collected and
// every claim held on "secrets not known".
//
// WHAT IT CHANGES, and nothing more:
//   * The SAME url. Every address it tries is one the system resolver returned for the url's own hostname: no address,
//     provider or authority is configured here, and none is added.
//   * The SAME trust. TLS verifies the certificate against the default trust store with the url's hostname as SNI and
//     as the identity checked (Node's checkServerIdentity). A certificate this box does not trust is NOT routed around:
//     an untrusted or mismatched identity is interception or a broken front, and either one has to surface, not be
//     hidden behind the next address. It ends the request.
//   * The SAME request, sent at most ONCE. Another address is tried only when the previous one failed BEFORE the
//     connection was established (TCP for http:, the full verified handshake for https:). Until then not one byte of the
//     request has left this box - Node holds the method, headers and body until the socket connects - so the next
//     address receives the identical bytes and the service sees them once. A failure after that point (a reset while
//     waiting for the answer, a timeout) is thrown: the request may have been delivered, and whether to ask again is the
//     caller's decision, exactly as before.
//   * The SAME answer. Any HTTP response - 403, 409, 429, 503, a redirect - is the service's answer and is returned as it
//     is: a refusal or a backoff is never retried at another address, and a redirect is never followed.
//   * The SAME deadline. timeoutMs and the caller's AbortSignal bound the whole request, every address included. A
//     handshake that hangs gives up its address after a share of what is left, so one black-holed front cannot spend
//     the whole budget.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

/** The shortest handshake an address is given before the next one is tried (unless less than that remains). */
export const MIN_CONNECT_MS = 2000;

// Failures that say only "this address is not answering": nothing of the request has been sent, and no identity was
// presented that this box refused. An `ERR_SSL_*` code is OpenSSL's protocol layer (an alert from the peer, a peer that
// does not speak TLS); a certificate this box refuses has its own codes (UNABLE_TO_VERIFY_LEAF_SIGNATURE,
// DEPTH_ZERO_SELF_SIGNED_CERT, CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID, ...) and is never on this list.
const UNAVAILABLE = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH",
  "ENETDOWN", "ETIMEDOUT", "EPIPE", "ENOTCONN", "EADDRNOTAVAIL", "ORIGIN_CONNECT_TIMEOUT"]);
const unavailable = (e) => UNAVAILABLE.has(e?.code) || /^ERR_SSL_/.test(String(e?.code || ""));

const aborted = (signal) => signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || "aborted"));

/**
 * originRequest(url, { method, headers, body, timeoutMs, signal, lookup, maxBytes }) -> { status, headers, text, address }
 *   lookup    dns.promises.lookup's shape; the default is the system resolver, in its own order
 *   maxBytes  the largest answer read (a certificate chain or a small JSON body; anything bigger is not one)
 * Throws when no address connects (code ORIGIN_UNREACHABLE, with every address's reason), when the connection that did
 * carry the request fails before the answer is complete, when an address presents an identity TLS refuses, and on the
 * deadline or the caller's abort.
 */
export async function originRequest(url, { method = "GET", headers = {}, body, timeoutMs = 30_000, signal,
                                           lookup = dns.promises.lookup, maxBytes = 1 << 20 } = {}) {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${u.protocol} is not an http(s) origin`);
  if (u.username || u.password) throw new Error("the origin url must not carry credentials");
  const deadline = Date.now() + timeoutMs;
  const all = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  if (all.aborted) throw aborted(all);
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  const tlsOn = u.protocol === "https:";
  const payload = body === undefined || body === null ? null : Buffer.from(body);

  let addrs;
  if (net.isIP(hostname)) addrs = [{ address: hostname, family: net.isIP(hostname) }];
  else {
    let onAbort;
    try {
      addrs = await Promise.race([lookup(hostname, { all: true }),
        new Promise((_, reject) => { onAbort = () => reject(aborted(all)); all.addEventListener("abort", onAbort, { once: true }); })]);
    } finally { all.removeEventListener("abort", onAbort); }
  }
  const seen = new Set();
  addrs = (Array.isArray(addrs) ? addrs : []).filter((a) => a && net.isIP(a.address) && !seen.has(a.address) && seen.add(a.address));
  if (!addrs.length) throw Object.assign(new Error(`${hostname} resolved to no address`), { code: "ORIGIN_UNREACHABLE" });

  const failed = [];
  for (let i = 0; i < addrs.length; i++) {
    const { address, family } = addrs[i];
    const left = deadline - Date.now();
    const connectMs = Math.min(left, Math.max(MIN_CONNECT_MS, left / (addrs.length - i)));
    try {
      return await once({ u, hostname, address, family, tlsOn, method, headers, payload, signal: all, connectMs, maxBytes });
    } catch (e) {
      if (all.aborted) throw aborted(all);
      if (!e.notSent || !unavailable(e)) throw e;
      failed.push(`${address} ${e.code}`);
    }
  }
  throw Object.assign(new Error(`${u.origin}: no address answered before the request was sent (${failed.join(", ")})`),
    { code: "ORIGIN_UNREACHABLE", notSent: true });
}

/** One address. A rejection carries notSent: true when the connection was never established. */
function once({ u, hostname, address, family, tlsOn, method, headers, payload, signal, connectMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let connected = false, settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const req = (tlsOn ? https : http).request({
      host: hostname, port: u.port || (tlsOn ? 443 : 80), path: `${u.pathname}${u.search}`, method,
      // The url's own name, for SNI and for the identity TLS checks; an address literal sends no SNI, as before.
      ...(tlsOn && !net.isIP(hostname) ? { servername: hostname } : {}),
      headers: { ...headers, host: u.host, ...(payload ? { "content-length": payload.length } : {}) },
      // Pinned to this one resolved address of the same name; a fresh socket, so no pooled one to another address.
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
      autoSelectFamily: false, agent: false, signal,
    });
    const timer = setTimeout(() => {
      if (!connected) req.destroy(Object.assign(new Error(`${address}: no ${tlsOn ? "TLS handshake" : "connection"} within ${Math.round(connectMs)} ms`),
        { code: "ORIGIN_CONNECT_TIMEOUT" }));
    }, connectMs);
    req.on("socket", (s) => s.once(tlsOn ? "secureConnect" : "connect", () => { connected = true; clearTimeout(timer); }));
    req.on("error", (e) => { if (!connected) e.notSent = true; done(reject, e); });
    req.on("response", (res) => {
      const parts = []; let n = 0;
      res.on("data", (c) => {
        n += c.length;
        if (n > maxBytes) { res.destroy(); done(reject, new Error(`${u.origin} answered more than ${maxBytes} bytes`)); } else parts.push(c);
      });
      res.on("error", (e) => done(reject, e));
      res.on("aborted", () => done(reject, new Error(`${u.origin} closed the answer before it was complete`)));
      res.on("end", () => done(resolve, { status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString("utf8"), address }));
    });
    req.end(payload || undefined);
  });
}
