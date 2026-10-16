// A FRESH Enclave Shield app partition report over a CALLER's nonce (a page verifying one app itself: verifier/web
// shield-app.mjs). The relay asks the live node once for the app guest's VBS report over that nonce (the node's
// /v1/shield/evidence, the same exchange the marketplace's own admission runs) and hands it back verbatim, beside what
// THIS relay expects: the app and runtime it derives from the deployment's catalog entry (expectedShieldApp) and the image
// measurements its Shield policy admits for that runtime. It vouches for nothing: the page checks the report's signature
// under the IDKS of the boot whose TPM quote it verified itself, the binding to its own nonce, and the measurement.
//
// A guest makes one report at a time, and the node's network agent asks each guest for a proof about every 20 s, so a
// page's report must stay rare and short (enclave-a8): one app check per box at a time, one per app every APP_GAP_MS, a
// single attempt (never retried here), and nothing when the node is already busy with evidence reads.
import fs from 'node:fs';
import { expectedShieldApp } from './shield-app-verifier.mjs';

const HEX64 = /^[0-9a-f]{64}$/, DEP = /^0x[0-9a-f]{64}$/;
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// the image measurements a policy admits for an expected app (shield-app-policy.mjs verifyShieldAppPolicy's candidates)
export function admittedImages(policy, expected) {
  return (Array.isArray(policy?.images) ? policy.images : []).filter((p) => HEX64.test(p?.measurement || '') && p.runtimeId === expected.runtimeId &&
    (!expected.requiresConfigBundleV5 || p.configBundleV5 === true) && (!expected.requiresSecretsV1 || p.secretsV1 === true) &&
    (!expected.requiresConfigSocketServer || p.configSocketServer === true)).map((p) => p.measurement);
}

// the public deployments a box serves now: active, public, leased to this box's registry id, the lease not yet expired
export function appsOn(host, rows, now = Date.now()) {
  const id = String(host?.id || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) return [];
  return (rows || []).filter((d) => d && d.active === true && d.isPublic === true && String(d.runner || '').toLowerCase() === id &&
    Number(d.leaseUntil) * 1000 > now).map((d) => ({ id: String(d.id).toLowerCase(), appRef: String(d.appRef || '') }));
}

export function createShieldAppFresh({ hub, policyFile = '', policy: supplied = null, confirmRow, readCatalog, readConfig, fetchVerified,
  hasSecrets = () => false, isOwnerDeployment = () => false, appGapMs = 30000, now = Date.now,
  expect = expectedShieldApp } = {}) {   // expect: tests stand in for the catalog derivation
  const policy = supplied || (policyFile ? JSON.parse(fs.readFileSync(policyFile, 'utf8')) : null);
  const busy = new Set();          // box names with an app check in flight
  const lastAt = new Map();        // deployment id -> when its last check started
  return async function freshApp(host, deploymentId, nonce) {
    if (!policy || policy.schema !== 'enclave-shield-app-policy/1') throw fail('not_configured', 'Enclave Shield app checks are not configured on this relay');
    const name = host?.name, id = String(deploymentId || '').toLowerCase();
    if (!DEP.test(id)) throw fail('bad_deployment', 'the deployment must be 0x and 64 hex characters');
    if (!Buffer.isBuffer(nonce) || nonce.length !== 32) throw fail('bad_nonce', 'the nonce must be 32 bytes');
    const info = name ? hub.info(name) : null;
    if (!info || info.mode !== 'hv-node') throw fail('no_box', `no attested Enclave Shield host named ${name} is attached`);
    if (busy.has(name)) throw fail('busy', 'an app check is already in flight on this host', { retryAfter: 5 });
    const wait = (lastAt.get(id) || 0) + appGapMs - now();
    if (wait > 0) throw fail('busy', `this app was checked moments ago; retry in ${Math.ceil(wait / 1000)} s`, { retryAfter: Math.ceil(wait / 1000) });
    busy.add(name); lastAt.set(id, now());
    try {
      const d = await confirmRow(id);
      if (!d || d.active !== true || d.isPublic !== true || String(d.runner || '').toLowerCase() !== String(host.id || '').toLowerCase() ||
          Number(d.leaseUntil) * 1000 <= now()) throw fail('not_here', `${id} is not a public deployment leased to ${name} now`);
      const expected = await expect(d, { policy, readCatalog, readConfig, fetchVerified, allowPendingOwner: isOwnerDeployment(host, d), secretsRequired: hasSecrets(d.id) });
      let r;
      try { r = await hub.request(`tunnel://${name}`, { method: 'GET', path: `/v1/shield/evidence?deployment=${id}&nonce=${nonce.toString('hex')}` }); }
      catch (e) { throw fail('timeout', `the host did not answer: ${e.message}`); }
      let proof = null; try { proof = JSON.parse(r.body.toString('utf8')); } catch {}
      if (r.status === 429) throw fail('busy', 'the host is answering other evidence reads; retry shortly', { retryAfter: 10 });
      if (r.status !== 200 || !proof || typeof proof.handshakeSpki !== 'string' || proof.handshakeSpki.length > 5500 || !proof.doc || typeof proof.doc !== 'object')
        throw fail('attestation_failed', `the host gave no app report (${r.status}${proof?.reason ? `: ${String(proof.reason).slice(0, 200)}` : proof?.error ? `: ${String(proof.error).slice(0, 200)}` : ''})`);
      // the relay's only filter: the report answers THIS nonce (a stale or foreign answer is dropped)
      if (proof.doc.nonce !== nonce.toString('hex')) throw fail('attestation_failed', 'the host\'s app report answers another nonce');
      return { document: proof.doc, handshakeSpki: proof.handshakeSpki,
        expected: { source: 'derived by this relay from the deployment\'s catalog entry and configuration, not stated by the app', appSha256: expected.appSha256, runtimeId: expected.runtimeId },
        policy: { source: 'this relay\'s Enclave Shield app policy (the operator\'s own list of admitted images)', measurements: admittedImages(policy, expected),
                  minimumGuestSvn: policy.minimumGuestSvn ?? 0, platforms: policy.platforms } };
    } finally { busy.delete(name); }
  };
}
