// A FRESH SEV-SNP app guest report over a CALLER's nonce (a page verifying one app itself: verifier/web snp-app.mjs).
// On a confidential server every app runs in its own SEV-SNP guest (isolation/m4/guestd), and that guest's front
// (isolation/m2/front) answers GET /.well-known/enclave-attestation?nonce= inside the app's own TLS, on the same listener and
// key as the app: the front refuses to install a certificate for any other key (certs.go). So the relay asks the app's
// public origin once, over ordinary TLS, records the key that origin presented in the handshake, and hands both back
// verbatim. It vouches for nothing: the page checks the AMD chain, the binding of that key and its own nonce, the app, the
// deployment id in HOST_DATA, and the measurement against the relay's published prediction (/v1/expected-guest), whose
// source the verdict names.
//
// A guest makes one report at a time and its node renews the guest's certificate with reports of its own, so page reports
// stay rare and short, as for Shield apps (shield-app-fresh.mjs): one app check per box at a time, one per app every
// APP_GAP_MS, a single attempt (never retried here). Only a public deployment leased to the box now.
import https from 'node:https';

export const ATTEST_PATH = '/.well-known/enclave-attestation';
const DEP = /^0x[0-9a-f]{64}$/, MAX_DOC = 64 * 1024;
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// ONE GET of the app origin's attestation path: { status, doc|null, handshakeSpki (base64 SPKI DER of the certificate the
// origin presented) }. Ordinary WebPKI validation: the hostname must hold a valid certificate, and the key in it is the key
// the page then requires the report to bind.
export function originAttestation(host, nonceHex, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, path: `${ATTEST_PATH}?nonce=${nonceHex}`, timeout: timeoutMs, headers: { accept: 'application/json' }, agent: false }, (res) => {
      let spki;
      try { spki = res.socket.getPeerX509Certificate().publicKey.export({ type: 'spki', format: 'der' }); }
      catch (e) { res.resume(); return reject(fail('attestation_failed', `the app origin's certificate could not be read: ${e.message}`)); }
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > MAX_DOC) { res.destroy(); reject(fail('attestation_failed', `the app's answer exceeds ${MAX_DOC} bytes`)); } else chunks.push(c); });
      res.on('end', () => { let doc = null; try { doc = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve({ status: res.statusCode, doc, handshakeSpki: spki.toString('base64') }); });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(fail('timeout', `the app origin did not answer within ${timeoutMs} ms`)));
    req.on('error', (e) => reject(e.code === 'timeout' ? e
      : e.code === 'ENOTFOUND' ? fail('no_origin', `${host} does not resolve: this app has no public web address, so its guest cannot be asked from outside`)
      : fail('timeout', `the app origin did not answer: ${e.message}`)));
  });
}

// the primary public origin of an on-chain deployment: the first 8 hex digits of its id under the app domain
export const appOrigin = (appDomain, id) => `${id.slice(2, 10)}.${appDomain}`;

export function createSnpAppFresh({ confirmRow, appDomain = '', fetchOrigin = originAttestation, appGapMs = 30000, now = Date.now } = {}) {
  const busy = new Set();          // box names with an app check in flight
  const lastAt = new Map();        // deployment id -> when its last check started
  return async function freshApp(host, deploymentId, nonce) {
    if (!appDomain) throw fail('not_configured', 'SEV-SNP app checks need the app domain (APP_DOMAIN) on this relay');
    const name = host?.name, id = String(deploymentId || '').toLowerCase();
    if (!DEP.test(id)) throw fail('bad_deployment', 'the deployment must be 0x and 64 hex characters');
    if (!Buffer.isBuffer(nonce) || nonce.length !== 32) throw fail('bad_nonce', 'the nonce must be 32 bytes');
    if (!name || host.mode !== 'snp') throw fail('no_box', `no attested SEV-SNP host named ${name} is attached`);
    if (busy.has(name)) throw fail('busy', 'an app check is already in flight on this host', { retryAfter: 5 });
    const wait = (lastAt.get(id) || 0) + appGapMs - now();
    if (wait > 0) throw fail('busy', `this app was checked moments ago; retry in ${Math.ceil(wait / 1000)} s`, { retryAfter: Math.ceil(wait / 1000) });
    busy.add(name); lastAt.set(id, now());
    try {
      const d = await confirmRow(id);
      if (!d || d.active !== true || d.isPublic !== true || String(d.runner || '').toLowerCase() !== String(host.id || '').toLowerCase() ||
          Number(d.leaseUntil) * 1000 <= now()) throw fail('not_here', `${id} is not a public deployment leased to ${name} now`);
      const origin = appOrigin(appDomain, id), nonceHex = nonce.toString('hex');
      const r = await fetchOrigin(origin, nonceHex);
      if (r.status === 429 || r.status === 503) throw fail('busy', `the app's guest is busy (HTTP ${r.status}); retry in ${Math.ceil(appGapMs / 1000)} s`, { retryAfter: Math.ceil(appGapMs / 1000) });
      if (r.status !== 200 || !r.doc || typeof r.doc !== 'object' || Array.isArray(r.doc) || typeof r.handshakeSpki !== 'string' || r.handshakeSpki.length > 5500)
        throw fail('attestation_failed', `the app origin gave no attestation document (HTTP ${r.status})`);
      // the relay's only filter: the report answers THIS nonce (a stale or foreign answer is dropped)
      if (r.doc.nonce !== nonceHex) throw fail('attestation_failed', 'the app\'s report answers another nonce');
      return { document: r.doc, handshakeSpki: r.handshakeSpki, origin: `https://${origin}${ATTEST_PATH}`,
        expectedFrom: `/v1/expected-guest?id=${id}` };
    } finally { busy.delete(name); }
  };
}
