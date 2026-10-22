// metal/guest/native-issuer.mjs -- the existing native CA, held by the platform API group and used by its PRIMARY only, to
// issue and renew the native control leaf of each group member bound to serve the native control names
// (metal/guest/measured-control.mjs nativeControl). It replaces the CA holder's manual request/issue/install
// (scripts/native-control-certificate.mjs, which stays the offline fallback) with the same steps, in the group:
//
//   where the CA lives   the admin-signed platform credentials NATIVE_CA_KEY (PEM) and NATIVE_CA_CERT (PEM): sealed to the
//                        primary's boot, replicated only as AEAD under the group key K, archived as ciphertext with K escrowed
//                        to the admin recovery keys (metal/guest/platform-api-role.mjs). Never in a config, an environment, the
//                        relay child or a log. A newer admin package without them revokes issuance.
//   who is issued        only a member of THIS group's platformApi.members, judged on its ACTUAL serving boot:
//     1. its bound config, fetched from its control URL (GET /platform-api/config: public data, trusted only through step 2),
//        must carry this group's platformApi member exactly, name that member's identity, and bind nativeControl to THIS CA;
//     2. verifyMeasuredControl (unchanged) at that control URL: AMD chain, the group's measurements and TCB floor, HOST_DATA =
//        exactly that config, TLS peer = the attested key, the supervisor's minted keys, and the ORIGINAL registry row;
//     3. a fresh platform host policy decision for that registry id with the verifier's chip (network/native-control-routes.mjs
//        nativeHostDecision, the same decision native discovery makes); explicitly "off" refuses;
//     4. the request (nativeCertificateRequest) from the evidence re-read over a connection pinned to the attested key: only
//        the boot's PUBLIC key and its bound names;
//   what is issued       signNativeLeaf: the existing profile, 7 days, never past the CA, for exactly the bound names;
//   how it is delivered  the guest's own install endpoint (PUT /.well-known/enclave-native-certificate), pinned to the
//                        attested key, whose checks (bound CA, its own key, a real TLS handshake per name, later expiry) stand.
//                        The primary's own front is another process of its guest: reached at https://127.0.0.1:<controlPort>,
//                        never through a public hairpin and never through a native name (no bootstrap loop).
//   when                 one round at a time (single-flight), every roundMs; a member is only verified when its served leaf
//                        is missing, foreign, or within renewBeforeMs of expiry; a refused member backs off (reset by a new boot).
//   barrier              right before an install: still this run (no stop, credential change or leadership change since), the
//                        native CA credentials unchanged, the platform host policy decided AGAIN (a ban since step 3 stops
//                        it), and a majority-acknowledged commit as primary (state-replica) - the same barrier the relay's
//                        outbound requests wait for. Otherwise nothing is installed. A stop also aborts the run's connections.
//   bounds               one attempt per member at a time; a timed-out attempt is aborted (its connections end) and its late
//                        result discarded; the verifier's own requests carry their own timeouts.
import { randomBytes, X509Certificate } from 'node:crypto';
import { canonicalJson, sha256Hex, EVIDENCE_PATH, NATIVE_CERT_PATH, NATIVE_NAMES } from './measured-control.mjs';
import { nativeCertificateRequest, nativeCaFacts, signNativeLeaf, pinnedRequest, untrustedRead, installNativeCertificate, MAX_DAYS } from './native-certificate.mjs';

export const NATIVE_CA_KEY = 'NATIVE_CA_KEY', NATIVE_CA_CERT = 'NATIVE_CA_CERT', NATIVE_CA_PREFIX = 'NATIVE_CA_';
/** the role's read-only peer path for its bound (public) config; verified by the reader through HOST_DATA, never trusted */
export const CONFIG_PATH = '/platform-api/config';
/** a credential the relay child never receives (environment or file) */
export const isNativeCaCredential = (name) => String(name).startsWith(NATIVE_CA_PREFIX);
const lc = (s) => String(s || '').toLowerCase();
const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 240);

/** The native CA credentials of a credentials document -> null (none held), { error } (malformed set), or { caKeyPem, caCertPem, digest } */
export function nativeCaCredentials(creds) {
  const names = Object.keys(creds || {}).filter(isNativeCaCredential);
  if (!names.length) return null;
  const k = creds[NATIVE_CA_KEY], c = creds[NATIVE_CA_CERT];
  if (typeof k !== 'string' || typeof c !== 'string' || names.length !== 2) return { error: `the native CA credentials are exactly ${NATIVE_CA_KEY} and ${NATIVE_CA_CERT}` };
  // the digest only detects a change; it is compared in memory and never shown
  return { caKeyPem: k, caCertPem: c, digest: sha256Hex('enclave native CA credentials v1\n', k, '\0', c) };
}

/**
 * Is the leaf a front serves now one THIS CA issued over the key that front presents, in the native profile, valid now and
 * far enough from expiry? -> { peerSpkiSha256, validTo (ms) | null }. The GET is untrusted discovery: only a leaf that passes
 * every check here (signature by the held CA, issued-by, the presented key, not a CA, serverAuth, names within the native
 * names, validity started, not past the CA) can make the issuer skip a renewal; anything else leads to full verification.
 */
export async function servedLeaf(url, ca, { timeoutMs, signal, now = Date.now() } = {}) {
  let r;
  try { r = await untrustedRead(url, NATIVE_CERT_PATH, { timeoutMs, maxBytes: 64 * 1024, signal }); } catch (e) { if (signal?.aborted) throw e; return { peerSpkiSha256: null, validTo: null }; }
  const out = { peerSpkiSha256: r.peerSpkiSha256 ?? null, validTo: null };
  if (r.status !== 200) return out;
  const blocks = r.body.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  try {
    if (blocks.length !== 2) return out;
    const leaf = new X509Certificate(blocks[0]), servedCa = new X509Certificate(blocks[1]);
    const from = Date.parse(leaf.validFrom), to = Date.parse(leaf.validTo), san = String(leaf.subjectAltName || '').split(', ');
    if (servedCa.raw.equals(ca.raw) && leaf.checkIssued(ca) && leaf.verify(ca.publicKey) && !leaf.ca
        && sha256Hex(leaf.publicKey.export({ type: 'spki', format: 'der' })) === out.peerSpkiSha256
        && (leaf.keyUsage || []).includes('1.3.6.1.5.5.7.3.1') && san.length >= 1 && san.every((x) => NATIVE_NAMES.includes(x.replace(/^DNS:/, '')) && x.startsWith('DNS:'))
        && from <= now && now < to && to <= Date.parse(ca.validTo))
      out.validTo = to;
  } catch {}
  return out;
}

/**
 * createNativeIssuer(opts) -> { start(credentials, why), stop(why), status(), round() }
 *   members, self, platformApi, ownConfig   the group (platformApi.members), this member's index, the group member, this boot's config
 *   selfUrl            this guest's own control front on loopback (https://127.0.0.1:<controlPort>)
 *   deps               { verify({url, config}), decideHost(registryId, {chipId}) } or an async factory of it
 *                      (issuerDeps below: the production verifier, registry, collateral and platform host policy)
 *   barrier            async () -> true only while a majority acknowledges this member as primary (the role: node.commit())
 *   credentialsDigest  () -> the digest of the native CA credentials the group holds NOW (nativeCaCredentials(...).digest)
 *   hooks              TESTS ONLY: { beforeBarrier({member}) } awaited right before the barrier
 */
export function createNativeIssuer({ members, self, platformApi, ownConfig, selfUrl, deps, barrier, credentialsDigest, log = () => {}, now = Date.now,
  roundMs = 5 * 60e3, memberTimeoutMs = 120e3, renewBeforeMs = 2 * 86400e3, maxBackoffMs = 3600e3, days = MAX_DAYS, requestTimeoutMs = 15000, hooks = {} }) {
  let active = null, refused = null, running = null, depsP = null;
  const states = members.map(() => ({ state: 'pending', reason: null, validTo: null, failures: 0, retryAt: 0, failedSpki: null, at: null }));
  const resolveDeps = () => (depsP ||= Promise.resolve(typeof deps === 'function' ? deps() : deps).catch((e) => { depsP = null; throw e; }));

  function stop(why) {
    if (!active) return;
    // the run ends NOW: its timer, and every connection it holds (the abort destroys them); a later step sees it is not live
    clearInterval(active.timer); active.abort.abort(); active = null;
    log(`native CA issuer stopped (${why})`);
  }
  function start(creds, why = 'primary') {
    if (creds && !creds.error && active && active.digest === creds.digest) return;
    stop('native CA credentials changed');
    refused = null;
    let facts;
    try {
      if (!creds) throw new Error('no native CA credentials');
      if (creds.error) throw new Error(creds.error);
      facts = nativeCaFacts({ caCertPem: creds.caCertPem, caKeyPem: creds.caKeyPem, now: now() });
    } catch (e) { refused = short(e); log(`native CA issuer refused: ${refused}`); return; }
    const run = { digest: creds.digest, caKeyPem: creds.caKeyPem, caCertPem: creds.caCertPem, caSha256: facts.caSha256, ca: facts.ca, timer: null, abort: new AbortController() };
    active = run;
    for (const s of states) Object.assign(s, { failures: 0, retryAt: 0, failedSpki: null });
    log(`native CA issuer active (${why}): CA sha256:${facts.caSha256.slice(0, 16)}…, ${members.length} member(s), round every ${Math.round(roundMs / 1000)} s`);
    const tick = () => { if (active === run && !running) running = round(run).catch((e) => log(`native issuance round failed: ${short(e)}`)).finally(() => { running = null; }); };
    run.timer = setInterval(tick, roundMs); run.timer.unref?.();
    setTimeout(tick, 0).unref?.();
  }
  const set = (i, state, extra = {}) => {
    const s = states[i], changed = s.state !== state || s.reason !== (extra.reason ?? null);
    Object.assign(s, { state, reason: extra.reason ?? null, at: new Date(now()).toISOString() }, 'validTo' in extra ? { validTo: extra.validTo } : {});
    if (changed) log(`native leaf, member ${i}: ${state}${extra.reason ? ` (${extra.reason})` : ''}${extra.validTo ? ` until ${new Date(extra.validTo).toISOString()}` : ''}`);
  };

  // Outstanding work is bounded: one attempt per member at a time. A timed-out attempt is aborted (its connections end at
  // once); a step that takes no signal (the verifier, whose every request has its own timeout) may still finish, but its
  // result is discarded, and that member is not attempted again until it has.
  const outstanding = new Map();
  async function round(run) {
    for (let i = 0; i < members.length && active === run; i++) {
      if (outstanding.has(i)) { set(i, states[i].state, { reason: 'an earlier attempt is still finishing' }); continue; }
      const job = { abandoned: false, abort: new AbortController() };
      const stopJob = () => job.abort.abort();
      run.abort.signal.addEventListener('abort', stopJob, { once: true });
      const attempt = member(run, i, job);
      outstanding.set(i, attempt);
      attempt.catch(() => {}).finally(() => { outstanding.delete(i); run.abort.signal.removeEventListener('abort', stopJob); });
      let t;
      try {
        await Promise.race([attempt, new Promise((_, no) => { t = setTimeout(() => no(new Error(`no result within ${memberTimeoutMs} ms`)), memberTimeoutMs); t.unref?.(); })]);
      } catch (e) {
        job.abandoned = true; job.abort.abort();             // a late answer of an abandoned attempt never installs
        if (e?.ended || active !== run) { set(i, 'aborted', { reason: 'the issuance run ended (stopped, credentials changed or no longer primary): nothing installed' }); return; }
        const s = states[i];
        s.failures++; s.retryAt = now() + Math.min(roundMs * 2 ** (s.failures - 1), maxBackoffMs); s.failedSpki = job.peerSpkiSha256 ?? null;
        set(i, 'refused', { reason: short(e) });
      } finally { clearTimeout(t); }
    }
  }

  async function member(run, i, job) {
    const m = members[i], url = i === self ? selfUrl : m.controlUrl, s = states[i];
    const live = () => active === run && !job.abandoned, signal = job.abort.signal;
    const step = () => { if (!live()) throw Object.assign(new Error('the issuance run ended'), { ended: true }); };
    // 1. is renewal due? (what the front serves now; a wrong answer can only make this round skip or retry)
    const served = await servedLeaf(url, run.ca, { timeoutMs: requestTimeoutMs, signal, now: now() });
    step();
    job.peerSpkiSha256 = served.peerSpkiSha256;
    if (served.validTo && served.validTo - now() > renewBeforeMs) { s.failures = 0; s.retryAt = 0; return set(i, 'current', { validTo: served.validTo }); }
    // a refused member waits out its backoff, unless it is a new boot (another control key) since it was refused
    if (s.retryAt > now() && served.peerSpkiSha256 === s.failedSpki) return;
    const d = await resolveDeps();
    step();
    // 2. its bound config: the identical group member, this member's identity, bound to serve native names under THIS CA
    let config = ownConfig, configPeer = null;
    if (i !== self) {
      const r = await untrustedRead(url, CONFIG_PATH, { timeoutMs: requestTimeoutMs, maxBytes: 256 * 1024, signal });
      step();
      if (r.status !== 200) throw new Error(`its bound config is unavailable (HTTP ${r.status})`);
      let o; try { o = JSON.parse(r.body); } catch { throw new Error('its bound config is not JSON'); }
      config = o && o.config; configPeer = r.peerSpkiSha256;
    }
    if (!config || typeof config !== 'object' || canonicalJson(config.platformApi ?? null) !== canonicalJson(platformApi)) throw new Error('its bound config does not carry this group\'s platformApi member');
    if (lc(config.identity?.operator) !== lc(m.operator) || config.identity?.publicUrl !== m.publicUrl) throw new Error('its bound config names another identity than the member');
    if (!config.nativeControl) return set(i, 'not-bound', { reason: 'its config serves no native control names' });
    if (config.nativeControl.caSha256 !== run.caSha256) throw new Error('it is bound to another native CA than the one this group holds');
    // 3. the serving boot itself, against exactly that config, the group's measurements and the original registry
    const v = await d.verify({ url, config });
    step();
    if (!v || v.status !== 'verified') throw new Error(`attestation ${v?.status ?? 'missing'}: ${(v?.reasons || []).filter((x) => /^(REJECT|UNKNOWN|PENDING)|report:/.test(x)).slice(-2).join('; ').slice(0, 200)}`);
    if (v.identity.operator !== lc(m.operator) || v.identity.publicUrl !== m.publicUrl) throw new Error('the attested boot is not this member');
    if (configPeer !== null && configPeer !== v.identity.controlTlsSpkiSha256) throw new Error('its config was answered by another key than the attested boot');
    // 4. the admin's platform host policy, fresh, for THAT registry id and the chip the verifier proved
    let dec;
    try { dec = await d.decideHost(v.identity.registryId, { chipId: v.identity.chipId ?? null }); } catch (e) { throw new Error(`platform host policy unreadable: ${short(e)}`); }
    step();
    if (!dec || dec.admit !== true) throw new Error(`refused by the platform host policy: ${dec?.reason || dec?.status || 'no decision'}`);
    if (!dec.host || lc(dec.host.operator) !== v.identity.operator || dec.host.active === false) throw new Error('the policy decision names another registry row than the attested host');
    // 5. the request: the boot's PUBLIC key and bound names, from evidence re-read over a connection pinned to that key
    const ev = await pinnedRequest(url, { path: `${EVIDENCE_PATH}?nonce=${randomBytes(32).toString('hex')}`, spkiSha256: v.identity.controlTlsSpkiSha256, timeoutMs: requestTimeoutMs, signal });
    step();
    if (ev.status !== 200) throw new Error(`evidence re-read: HTTP ${ev.status}`);
    const request = nativeCertificateRequest({ evidence: JSON.parse(ev.body), identity: v.identity });
    if (request.caSha256 !== run.caSha256 || request.names.join() !== config.nativeControl.names.join() || request.registryId !== v.identity.registryId)
      throw new Error('the request does not match the verified boot');
    const chainPem = signNativeLeaf({ request, caCertPem: run.caCertPem, caKeyPem: run.caKeyPem, days, now: now() });
    // 6. the barrier: still this run, the same native CA credentials, and a majority-acknowledged primary
    if (hooks.beforeBarrier) await hooks.beforeBarrier({ member: i });
    const holds = () => live() && credentialsDigest() === run.digest;
    if (!holds()) { job.abandoned = true; return set(i, 'aborted', { reason: 'no longer the run holding these native CA credentials: nothing installed' }); }
    // the admission is decided AGAIN right before the install (a ban since step 4 stops it), then the primary is confirmed
    let again;
    try { again = await d.decideHost(v.identity.registryId, { chipId: v.identity.chipId ?? null }); } catch (e) { throw new Error(`platform host policy unreadable at install: ${short(e)}`); }
    step();
    if (!again || again.admit !== true || !again.host || lc(again.host.operator) !== v.identity.operator) throw new Error(`refused by the platform host policy at install: ${again?.reason || again?.status || 'no decision'}`);
    if (!holds() || !(await barrier()) || !holds()) { job.abandoned = true; return set(i, 'aborted', { reason: 'no longer the primary holding these native CA credentials: nothing installed' }); }
    const r = await installNativeCertificate({ controlUrl: url, chainPem, spkiSha256: v.identity.controlTlsSpkiSha256, timeoutMs: requestTimeoutMs, signal });
    if (r.status !== 200) throw new Error(`the member refused the leaf: HTTP ${r.status} ${String(r.body).slice(0, 160)}`);
    let validTo = null; try { validTo = Date.parse(JSON.parse(r.body).validTo); } catch {}
    s.failures = 0; s.retryAt = 0; s.failedSpki = null;
    set(i, 'issued', { validTo, reason: null });
    log(`native leaf issued to member ${i} (boot ${request.bootId}, ${request.names.join(', ')})`);
  }

  return {
    start, stop,
    round: () => (active && !running ? (running = round(active).finally(() => { running = null; })) : running || Promise.resolve()),
    status: () => ({ state: active ? 'active' : refused ? 'refused' : 'inactive', reason: refused, caSha256: active ? active.caSha256 : null,
      members: states.map((s, i) => ({ member: i, state: s.state, reason: s.reason, validTo: s.validTo ? new Date(s.validTo).toISOString() : null, at: s.at })) }),
  };
}

/**
 * The issuer's production dependencies: the UNCHANGED verifier (metal/measured-control-verify.mjs), the original registry
 * through this guest's bound RPC quorum (the handoff's reader), AMD collateral, and the platform host policy resolved
 * exactly as native discovery resolves it (production unless configured; explicitly "off" refuses every issuance).
 *   policyEnv  the relay's own non-credential environment (relayEnvBase + platformApi.relayEnv)
 *   collateral the AMD collateral source; registry/roots/fetch: test fixtures only (offline)
 */
export async function issuerDeps({ platformApi: pa, ownConfig, policyEnv = {}, collateral, registry = null, roots = null, fetch = globalThis.fetch, log = () => {}, timeoutMs = 15000 }) {
  const { verifyMeasuredControl } = await import('../measured-control-verify.mjs');
  const { quorumRegistry } = await import('./platform-api-verify.mjs');
  const { createHostPolicyRuntime, resolveHostPolicyConfig } = await import('../../network/host-policy-runtime.mjs');
  const { PRODUCTION_BOOK } = await import('../../network/platform-host-policy-config.mjs');
  const { freshAdmissions } = await import('../../network/host-policy-adapters.mjs');
  const { nativeHostDecision } = await import('../../network/native-control-routes.mjs');
  const reg = registry || quorumRegistry({ rpcs: ownConfig.rpcs, quorum: ownConfig.quorum, registry: ownConfig.contracts.registry });
  const runtime = createHostPolicyRuntime(resolveHostPolicyConfig({ env: policyEnv, chainId: 8453, book: PRODUCTION_BOOK }), { fetch, log });
  const decide = runtime ? freshAdmissions(runtime.gate) : null;
  return {
    verify: ({ url, config }) => verifyMeasuredControl({ url, collateral, registry: reg, timeoutMs,
      expect: { config, measurements: pa.measurements, ...(pa.minTcb ? { minTcb: pa.minTcb } : {}), ...(roots ? { roots } : {}) } }),
    decideHost: async (registryId, { chipId = null } = {}) => {
      if (!runtime) return { admit: false, status: 'off', reason: 'the platform host policy is explicitly off: a native leaf is issued only to a host the policy judged' };
      return nativeHostDecision((await decide([registryId]))[lc(registryId)], runtime.gate.accepted()?.policy || null, chipId, { now: Date.now });
    },
  };
}
