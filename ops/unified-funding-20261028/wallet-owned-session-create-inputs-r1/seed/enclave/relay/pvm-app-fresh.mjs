// A FRESH phone app VM's evidence over a CALLER's nonce (a page verifying one app itself: verifier/web pvm-app.mjs).
// On a pVM market host every app runs in its own protected VM, and that VM's front (pvm-rt httpd.rs set_attest, the
// payload's well_known_attest) answers GET /.well-known/enclave-attestation?nonce= inside the app's own TLS, before the app
// sees the request: the same enclave-pvm-app-evidence/v4 document the market verifies at admission, which binds the VM's
// TLS key under its attested transport key. So the relay asks the app's public origin once, records the key that origin
// presented in the handshake, and hands both back verbatim, beside what THIS relay states:
//   - the app it expects, derived from the catalog (pvm-market.mjs expectedApp: the CID-verified component's SHA-256);
//   - the transport key the box attached with, and its operator allow-lists (the host route's own);
//   - when the app's VM is not the tunnel's own VM (it never is: apps run in sibling VMs), the SIBLING statement over the
//     same nonce, from the box (/v1/pvm/sibling), and the box's registered proof key: the page recovers the statement's
//     signer itself and requires that key, which only VMs of the pinned build ever hold (pvm-market.mjs checkHostVm).
// It vouches for nothing: the page checks the AVF chain, the challenge over its own nonce, the TLS binding and the signer.
//
// The VM's evidence budget is shared with the market's own checks (a few tokens, one more every 2 s), so page reports stay
// rare, as for Shield and SEV-SNP apps: one app check per box at a time, one per app every APP_GAP_MS, a single attempt.
import { originAttestation, appOrigin, ATTEST_PATH } from './snp-app-fresh.mjs';

const DEP = /^0x[0-9a-f]{64}$/, HEX64 = /^[0-9a-f]{64}$/;
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export function createPvmAppFresh({ hub, market, confirmRow, appDomain = '', operatorAllowlist = () => null, fetchOrigin = originAttestation,
  appGapMs = 30000, now = Date.now } = {}) {
  const busy = new Set();          // box names with an app check in flight
  const lastAt = new Map();        // deployment id -> when its last check started
  return async function freshApp(host, deploymentId, nonce) {
    if (!appDomain) throw fail('not_configured', 'pVM app checks need the app domain (APP_DOMAIN) on this relay');
    if (!market || !market.enabled) throw fail('not_configured', 'the pVM market is off on this relay');
    const name = host?.name, id = String(deploymentId || '').toLowerCase();
    if (!DEP.test(id)) throw fail('bad_deployment', 'the deployment must be 0x and 64 hex characters');
    if (!Buffer.isBuffer(nonce) || nonce.length !== 32) throw fail('bad_nonce', 'the nonce must be 32 bytes');
    const info = name ? hub.info(name) : null;
    if (!name || host.mode !== 'avf' || !info || info.mode !== 'avf' || !market.eligible(host) || typeof info.spki !== 'string')
      throw fail('no_box', `no admitted pVM market host named ${name} is attached`);
    if (busy.has(name)) throw fail('busy', 'an app check is already in flight on this host', { retryAfter: 5 });
    const wait = (lastAt.get(id) || 0) + appGapMs - now();
    if (wait > 0) throw fail('busy', `this app was checked moments ago; retry in ${Math.ceil(wait / 1000)} s`, { retryAfter: Math.ceil(wait / 1000) });
    busy.add(name); lastAt.set(id, now());
    try {
      const d = await confirmRow(id);
      if (!d || d.active !== true || d.isPublic !== true || String(d.runner || '').toLowerCase() !== String(host.id || '').toLowerCase() ||
          Number(d.leaseUntil) * 1000 <= now()) throw fail('not_here', `${id} is not a public deployment leased to ${name} now`);
      let expected;
      try { expected = await market.expectedApp(d); } catch (e) { throw fail('attestation_failed', `the expected app could not be derived: ${String(e.message).slice(0, 200)}`); }
      if (!expected || !HEX64.test(String(expected.appId || ''))) throw fail('attestation_failed', 'the expected app could not be derived');
      const origin = appOrigin(appDomain, id), nonceHex = nonce.toString('hex');
      const r = await fetchOrigin(origin, nonceHex);
      if (r.status === 429 || r.status === 503) throw fail('busy', `the app's VM is busy (HTTP ${r.status}); retry in ${Math.ceil(appGapMs / 1000)} s`, { retryAfter: Math.ceil(appGapMs / 1000) });
      if (r.status !== 200 || !r.doc || typeof r.doc !== 'object' || Array.isArray(r.doc) || typeof r.handshakeSpki !== 'string' || r.handshakeSpki.length > 5500)
        throw fail('attestation_failed', `the app origin gave no evidence document (HTTP ${r.status})`);
      // the relay's only filter: the evidence answers THIS nonce (a stale or foreign answer is dropped)
      if (r.doc.nonce !== nonceHex) throw fail('attestation_failed', 'the app\'s evidence answers another nonce');
      // the app's VM is the tunnel's own, or a sibling that must prove the box's proof key over the same nonce
      const attachHex = Buffer.from(info.spki, 'base64').toString('hex');
      let sibling = null, proofKey = null;
      if (r.doc.spki !== attachHex) {
        try { sibling = await hub.fetchJson(`tunnel://${name}`, `/v1/pvm/sibling?deployment=${id}&nonce=${nonceHex}`); } catch (e) { sibling = { error: String(e.message).slice(0, 200) }; }
        if (!sibling || typeof sibling !== 'object' || Array.isArray(sibling) || sibling.error) sibling = null;
        try { proofKey = await market.proofKeyOf(host.id); } catch { proofKey = null; }
      }
      return { document: r.doc, handshakeSpki: r.handshakeSpki, origin: `https://${origin}${ATTEST_PATH}`,
        expected: { source: 'derived by this relay from the deployment\'s catalog entry (the CID-verified component\'s SHA-256), not stated by the app', appSha256: expected.appId },
        attachTransportKey: info.spki, sibling, proofKey: proofKey ? String(proofKey).toLowerCase() : null, registryId: String(host.id || '').toLowerCase(),
        operatorAllowlist: operatorAllowlist() };
    } finally { busy.delete(name); }
  };
}

