// A host-local ACME (RFC 8555) http-01 client for the service-tls host role (network/host-services/service-tls.mjs,
// work/host-service-tls-20261021). One order names EXACTLY the host's own derived names (one certificate per host: Let's
// Encrypt counts new certificates per registered domain, which every host in the zone shares). It returns the PEM chain;
// the role chose the names, serves the http-01 answer on its port-80 front and accepts or refuses the chain with Node's
// own TLS verifier (service-tls.mjs verifyCertificate). No EAB, no relay, no platform issuer: the account key and the TLS
// key are generated on the host and never leave it.
//
// WHY THIS IS NOT AN IMPORT. There is no maintained ACME library in the tree's dependencies (root node_modules has jose,
// relay/network have asn1js; no acme-client). The Go one (golang.org/x/crypto/acme, isolation/m2/front/acme.go) would
// mean a new Windows binary in the pinned hs2 stage. The two existing JavaScript clients, supervisor.js (dns-01, CVM) and
// relay/certs.js (dns-01, relay), keep theirs as unexported functions of 12k- and 1k-line programs with module-level
// state, and neither may be edited here. So the SAME small functions are carried over, kept close to their originals:
// jwkThumbprint and jwsSignEs256 (byte-identical bodies), the DER writer and buildCsr (multi-name SAN, key passed in),
// acmePost's single badNonce retry and error mapping, acmeAccount's persisted account and accountDoesNotExist reset,
// acmePoll, the certificate download retry on 404 and acmeRetryAfterAt. Every protocol error path is tested against a
// fixture CA that checks our JWS with jose (test/service-tls.test.mjs). Factoring one shared module out of supervisor.js
// and relay/certs.js is a follow-up for root; nothing here changes them.
//
// Bounds, as in supervisor.js:
//   - every CA call is bounded (45 s, supervisor.js ACME_HTTP_MS: CAs sometimes take 25 s);
//   - polls give up after 90 s;
//   - one whole order gives up after 5 min;
//   - a response body over 256 KiB is refused.
// Every URL the CA hands back must be https on the directory's own origin, and no redirect is followed, so a directory
// cannot point the client at another host. One order at a time per client.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

export const ACME_DIRECTORIES = Object.freeze({ letsencrypt: 'https://acme-v02.api.letsencrypt.org/directory' });
export const ACME_HTTP_MS = 45_000, ACME_POLL_MS = 90_000, ACME_ORDER_MS = 5 * 60_000;
const MAX_BODY = 256 * 1024, CERT_FETCH_TRIES = 10, CERT_FETCH_GAP_MS = 3000, RATE_LIMIT_CAP_MS = 7 * 86400e3;

export const b64u = (b) => Buffer.from(b).toString('base64url');
const b64uJson = (o) => b64u(JSON.stringify(o));
// RFC 7638: exactly {"crv","kty","x","y"} in that order, no whitespace (supervisor.js jwkThumbprint)
export const jwkThumbprint = (jwk) => b64u(createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`).digest());
// flat JWS, ES256, raw R||S signature (supervisor.js jwsSignEs256); payload null -> "" (POST-as-GET)
export function jwsSignEs256(protectedHeader, payload, privateKey) {
  const prot = b64uJson(protectedHeader), body = payload === null ? '' : b64uJson(payload);
  const sig = cryptoSign('sha256', Buffer.from(`${prot}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return { protected: prot, payload: body, signature: b64u(sig) };
}

// ---- minimal DER writer + PKCS#10 CSR (supervisor.js buildCsr, with the key passed in so the role keeps it) ----------
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = []; for (let x = n; x > 0; x >>>= 8) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
export const derTlv = (tag, ...body) => { const b = Buffer.concat(body); return Buffer.concat([Buffer.from([tag]), derLen(b.length), b]); };
export const derSeq = (...p) => derTlv(0x30, ...p);
export const derSet = (...p) => derTlv(0x31, ...p);
export const derOctet = (b) => derTlv(0x04, b);
export const derBits = (b) => derTlv(0x03, Buffer.from([0]), b);
export const derUtf8 = (s) => derTlv(0x0c, Buffer.from(s, 'utf8'));
export const derCtx = (n, constructed, ...body) => derTlv((constructed ? 0xa0 : 0x80) | n, ...body);
export function derOid(oid) {
  const a = oid.split('.').map(Number), body = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) {
    const enc = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) enc.unshift((x & 0x7f) | 0x80);
    body.push(...enc);
  }
  return derTlv(0x06, Buffer.from(body));
}
export const pemWrap = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
/** A CSR for exactly `names` (CN = the first, SAN = every dNSName, in order), signed by `privateKey` (P-256). -> DER */
export function buildCsr(names, privateKey) {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const san = derSeq(...names.map((n) => derCtx(2, false, Buffer.from(n, 'ascii'))));
  const ext = derSeq(derOid('2.5.29.17'), derOctet(san));
  const attr = derSeq(derOid('1.2.840.113549.1.9.14'), derSet(derSeq(ext)));
  const cri = derSeq(derTlv(0x02, Buffer.from([0])), derSeq(derSet(derSeq(derOid('2.5.4.3'), derUtf8(names[0])))), spki, derCtx(0, true, attr));
  const sig = cryptoSign('sha256', cri, { key: privateKey, dsaEncoding: 'der' });
  return derSeq(cri, derSeq(derOid('1.2.840.10045.4.3.2')), derBits(sig));
}
export const newKey = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;

export const pemBlocks = (pem, label) => String(pem).match(new RegExp(`-----BEGIN ${label}-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+-----END ${label}-----`, 'g')) || [];

// ---- retry hints ------------------------------------------------------------------------------------------------------
/** supervisor.js acmeRetryAfterAt: the later of a "retry after <date>" in the detail and a Retry-After header; capped. */
export function retryAfterAt(detail, header, now = Date.now()) {
  let at = 0;
  const m = /retry after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(String(detail || ''));
  if (m) { const t = Date.parse(m[1]); if (t > at) at = t; }
  const h = String(header || '').trim();
  if (h) { const t = /^\d+$/.test(h) ? now + Number(h) * 1000 : Date.parse(h); if (Number.isFinite(t) && t > at) at = t; }
  return at > now ? Math.min(at, now + RATE_LIMIT_CAP_MS) : 0;
}

async function readBounded(r) {
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw new Error(`ACME response over ${MAX_BODY} bytes`);
  if (!r.body) return '';
  const parts = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > MAX_BODY) throw new Error(`ACME response over ${MAX_BODY} bytes`); parts.push(Buffer.from(c)); }
  return Buffer.concat(parts).toString('utf8');
}

/**
 * createAcmeClient({ directoryUrl, account: { load(), save(record), forget() }, fetch?, sleep?, log?, now? })
 * -> { issue(name, { key, challenges: { set(name, token, keyAuthorization), delete(name, token) }, signal? }) -> chain PEM,
 *      thumbprint() }
 * `account` persists { directory, kid, keyPem } (the role's state dir): Let's Encrypt counts new registrations per IP.
 */
export function createAcmeClient({ directoryUrl, account, fetch = globalThis.fetch, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)),
  log = () => {}, now = () => Date.now(), httpMs = ACME_HTTP_MS, pollMs = ACME_POLL_MS, orderMs = ACME_ORDER_MS, certFetchGapMs = CERT_FETCH_GAP_MS } = {}) {
  const origin = new URL(directoryUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('ACME directory must be an https URL');
  const ours = (u, what) => {
    let x; try { x = new URL(u); } catch { throw new Error(`ACME ${what} is not a URL`); }
    if (x.protocol !== 'https:' || x.origin !== origin.origin) throw new Error(`ACME ${what} is not on the directory's origin`);
    return x.href;
  };
  let dir = null, nonce = null, acct = null, signal = null;
  const call = (url, init = {}) => fetch(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(httpMs)]) : AbortSignal.timeout(httpMs) });
  async function directory() {
    if (dir) return dir;
    const r = await call(origin.href);
    if (!r.ok) throw new Error(`ACME directory: HTTP ${r.status}`);
    const text = await readBounded(r);
    let d; try { d = JSON.parse(text); } catch { throw new Error('ACME directory is not JSON'); }
    for (const k of ['newNonce', 'newAccount', 'newOrder']) d[k] = ours(d[k], k);
    return (dir = d);
  }
  async function takeNonce() {
    if (nonce) { const n = nonce; nonce = null; return n; }
    const r = await call((await directory()).newNonce, { method: 'HEAD' });
    const n = r.headers.get('replay-nonce');
    if (!n) throw new Error('ACME newNonce returned no replay-nonce');
    return n;
  }
  async function post(url, payload, { useJwk = false, accept = null } = {}) {
    for (let attempt = 0; ; attempt++) {
      const prot = { alg: 'ES256', nonce: await takeNonce(), url, ...(useJwk ? { jwk: acct.jwk } : { kid: acct.kid }) };
      const r = await call(url, { method: 'POST', headers: { 'content-type': 'application/jose+json', ...(accept ? { accept } : {}) }, body: JSON.stringify(jwsSignEs256(prot, payload, acct.key)) });
      nonce = r.headers.get('replay-nonce') || nonce;
      const isJson = /json/.test(r.headers.get('content-type') || '');
      const text = await readBounded(r);
      let data = text; if (isJson) { try { data = JSON.parse(text); } catch { data = null; } }
      if (r.status >= 400) {
        const type = String((isJson && data?.type) || '');
        if (attempt === 0 && /:badNonce$/.test(type)) continue;
        const e = new Error(`ACME ${r.status}: ${isJson ? `${type || '?'} ${String(data?.detail || '').slice(0, 200)}`.trim() : 'non-JSON error'}`);
        e.status = r.status; e.type = type;
        const until = retryAfterAt(data?.detail, r.headers.get('retry-after'), now());
        if (until) e.retryAt = until;
        // a stored account the CA no longer knows: forget it so the next attempt registers afresh
        if (/:accountDoesNotExist$/.test(type) && acct?.kid) { acct = null; account.forget(); }
        throw e;
      }
      return { status: r.status, headers: r.headers, data };
    }
  }
  async function ensureAccount() {
    if (acct?.kid) return acct;
    const d = await directory();
    if (d.meta?.externalAccountRequired) throw new Error('ACME CA requires External Account Binding (not supported: this role holds no CA credential)');
    const saved = account.load();
    if (saved && saved.directory === origin.href && typeof saved.kid === 'string') {
      try {
        const key = createPrivateKey(saved.keyPem), j = createPublicKey(key).export({ format: 'jwk' });
        acct = { key, jwk: { crv: j.crv, kty: j.kty, x: j.x, y: j.y }, kid: ours(saved.kid, 'account') };
        acct.thumbprint = jwkThumbprint(acct.jwk);
        return acct;
      } catch (e) { log(`[service-tls] stored ACME account unusable (${e.message}); registering afresh`); account.forget(); }
    }
    const key = newKey(), j = createPublicKey(key).export({ format: 'jwk' });
    acct = { key, jwk: { crv: j.crv, kty: j.kty, x: j.x, y: j.y }, kid: null };
    acct.thumbprint = jwkThumbprint(acct.jwk);
    try {
      const r = await post(d.newAccount, { termsOfServiceAgreed: true }, { useJwk: true });
      acct.kid = ours(r.headers.get('location') || '', 'account location');
    } catch (e) { acct = null; throw e; }
    account.save({ directory: origin.href, kid: acct.kid, keyPem: key.export({ type: 'pkcs8', format: 'pem' }) });
    log(`[service-tls] ACME account registered`);
    return acct;
  }
  async function poll(url, what, ok, bad) {
    const t0 = now();
    for (let delay = 1000; ; delay = Math.min(Math.round(delay * 1.5), 10_000)) {
      const { data, headers } = await post(url, null);
      if (ok(data)) return data;
      if (bad(data)) throw new Error(`${what} became ${data?.status}: ${String(JSON.stringify(data?.error || (data?.challenges || []).map((c) => c.error).filter(Boolean)) || '').slice(0, 200)}`);
      if (now() - t0 > pollMs) throw new Error(`${what} still ${data?.status} after ${Math.round(pollMs / 1000)} s`);
      const ra = retryAfterAt('', headers.get('retry-after'), now());
      await sleep(ra ? Math.min(10_000, Math.max(1000, ra - now())) : delay);
    }
  }
  // names: the exact identifier set (each a validated lowercase DNS name, distinct). challenges.set/delete hold the http-01
  // answer only while its authorization is pending; the role serves it for that exact name only.
  async function issue(names, { key, challenges, signal: outer = null }) {
    if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length) throw new Error('ACME order needs distinct names');
    const want = [...names].sort();
    signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(orderMs)]) : AbortSignal.timeout(orderMs);
    const pending = [];
    try {
      const a = await ensureAccount(), d = await directory();
      const order = await post(d.newOrder, { identifiers: names.map((value) => ({ type: 'dns', value })) });
      const o = order.data || {};
      // the CA must order exactly what we asked: these dns identifiers and one authorization each
      const got = Array.isArray(o.identifiers) ? o.identifiers.map((i) => (i?.type === 'dns' ? i.value : null)).sort() : [];
      if (got.length !== want.length || got.some((v, i) => v !== want[i])) throw new Error('ACME order names other identifiers');
      if (!Array.isArray(o.authorizations) || o.authorizations.length !== names.length) throw new Error('ACME order has other than one authorization per name');
      const orderUrl = ours(order.headers.get('location') || '', 'order location'), finalize = ours(o.finalize, 'finalize');
      const seen = new Set();
      for (const u of o.authorizations) {
        const authzUrl = ours(u, 'authorization');
        const authz = (await post(authzUrl, null)).data || {};
        const name = authz.identifier?.type === 'dns' ? authz.identifier.value : null;
        if (!names.includes(name) || seen.has(name) || authz.wildcard) throw new Error('ACME authorization is for another identifier');
        seen.add(name);
        if (authz.status === 'valid') continue;
        const chal = (authz.challenges || []).find((c) => c.type === 'http-01');
        if (!chal || !/^[A-Za-z0-9_-]{16,128}$/.test(String(chal.token))) throw new Error('ACME offered no usable http-01 challenge');
        const chalUrl = ours(chal.url, 'challenge');
        challenges.set(name, chal.token, `${chal.token}.${a.thumbprint}`); pending.push([name, chal.token]);
        await post(chalUrl, {});
        await poll(authzUrl, `authorization for ${name}`, (x) => x?.status === 'valid', (x) => ['invalid', 'revoked', 'deactivated', 'expired'].includes(x?.status));
        challenges.delete(name, chal.token); pending.pop();
      }
      await post(finalize, { csr: b64u(buildCsr(names, key)) });
      const done = await poll(orderUrl, 'order', (x) => x?.status === 'valid' && x.certificate, (x) => x?.status === 'invalid');
      const certUrl = ours(done.certificate, 'certificate');
      for (let i = 1; ; i++) {
        try { return String((await post(certUrl, null, { accept: 'application/pem-certificate-chain' })).data); }
        catch (e) { if (e.status !== 404 || i >= CERT_FETCH_TRIES) throw e; await sleep(certFetchGapMs); }
      }
    } finally { for (const [n, t] of pending) challenges.delete(n, t); signal = null; }
  }
  return { issue, thumbprint: () => acct?.thumbprint ?? null };
}
