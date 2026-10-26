// The provider's chain authority (network/wg-provider/main.mjs), as ONE explicit choice:
//   * absent / "quorum": the configured RPC quorum (cfg.rpc, two or more) for every chain read, and the host-services platform
//     host policy over its own policy RPC quorum - exactly as before;
//   * "verifier": the local loopback verifier (network/lease-reader.mjs chainAuthorityOptions), exactly as before;
//   * "attested-verifier": a REMOTE chain verifier inside a SEV-SNP-attested measured guest (network/attested-verifier-client.mjs).
//     EVERY chain read of this provider goes through that ONE client and nothing else:
//       - registry rows (control peers, provider records, deregistration = the admin's registry ban), app leases and owner
//         signatures (EOA; ERC-1271 and SessionVault through the verifier's eth_call, network/owner-signature.mjs) via the
//         LeaseReader;
//       - the host-services admission policy (anchored digest, the book's CURRENT owner, sequence, replay/rollback, bans and
//         persisted refusals, network/platform-host-policy.mjs, unchanged) via ONE verified snapshot of the same client.
//     An RPC list, a local verifier, a policy RPC list or a policy-level chain authority beside it are refused: no mixed authority, no
//     fallback. The provider checks the attestation, not proofs (labelled attested-verifier, localProof false).
//     A PAID provider's on-chain sends (setHost, qualify) need cfg.txBackend: the operator's OWN Base node (loopback or
//     private IPv4 literal) for submission, the pending nonce and fee hints only, bound to the verifier's head before
//     anything is signed; state, simulation, nonce and receipts stay the attested verifier's (attested-submission.mjs).
//     Without it (or with an invalid one) a paid provider refuses to start; an unpaid one must not name it.
//
// cfg.attestedVerifier = { unsafeSigner, replicas: [{ url, configFile (absolute: that replica's reviewed direct config JSON),
//   measurements: [96 hex], minTcb: { <product line>: { ...TCB fields } } }], collateral: { dir (absolute, pre-seeded AMD files:
//   amd/<product>-cert_chain.pem, amd/<product>-crl.der, vcek/<product>-<chip>-<tcb>.der), cacheDir? (absolute, writable,
//   separate: the authenticated cache), kds?: true (requires cacheDir) }, reattestSec?, timeoutMs? }
// cfg.txBackend (paid only) = { url, maxFeePerGasWei?, maxPriorityFeePerGasWei?, maxGas? } (attested-submission.mjs providerTxBackend)
// No configuration can name a trust root: AMD's pinned ARK is the only one (test roots are programmatic only).
import fs from 'node:fs';
import path from 'node:path';
import { chainAuthorityOptions } from '../lease-reader.mjs';
import { createAttestedVerifier } from '../attested-verifier-client.mjs';
import { fileCollateral, httpCollateral, layeredCollateral } from '../../verifier/collateral.mjs';
import { cachedCollateral } from '../../verifier/collateral-cache.mjs';
import { resolveHostPolicyConfig } from '../platform-host-policy-config.mjs';
import { createHostPolicyRuntime, verifiedHostSnapshot, fileStore } from '../host-policy-runtime.mjs';
import { hostServicesPolicyEnv } from './host-services-config.mjs';
import { providerTxBackend } from './attested-submission.mjs';

const bad = (m) => { throw new Error(`provider chain authority: ${m}`); };
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const absolute = (p, what) => { if (typeof p !== 'string' || !path.isAbsolute(p)) bad(`${what} must be an absolute path`); return p; };

/**
 * The provider's AMD collateral. The attestation verifier re-verifies whatever it is handed against AMD's pinned ARK, with
 * the replica's TCB floors and CRL "required"; this only decides where the bytes come from (docs/network/attested-provider-collateral.md).
 *   { dir }                      the pre-seeded read-only files only, no network (unchanged).
 *   { dir, cacheDir, kds? }      the authenticated, freshness-aware cache (verifier/collateral-cache.mjs) in cacheDir, which
 *                                must be writable and separate from dir. A fresh cached entry answers with no network; a CRL past its
 *                                nextUpdate goes to the upstream first and is served (flagged stale, so "required" rejects) only
 *                                when no upstream answers. Its upstream, per piece:
 *                                  chain: the pre-seeded file ONLY (an ASK rotation stays an operator decision, as in
 *                                         isolation/m2/host-collateral.mjs --allow-ask-rotation, never a KDS answer);
 *                                  VCEK:  the pre-seeded file, then AMD KDS when kds;
 *                                  CRL:   AMD KDS FIRST when kds, then the pre-seeded file (KDS outage).
 *   { dir, kds: true } without cacheDir is REFUSED (explicit migration): layered(file, KDS) answered with the pre-seeded CRL
 *   first, so an expired seed shadowed a fresh KDS CRL and attestation failed closed until an operator replaced the file.
 * roots/now: PROGRAMMATIC ONLY (tests): the cache's ARK pins and clock; main.mjs never passes them.
 */
export function providerCollateral(c, { http = httpCollateral, roots = null, now = null } = {}) {
  if (!plain(c) || Object.keys(c).some((k) => !['dir', 'cacheDir', 'kds'].includes(k))) bad('attestedVerifier.collateral: { dir, cacheDir?, kds? }');
  const dir = path.resolve(absolute(c.dir, 'attestedVerifier.collateral.dir'));
  if (c.kds !== undefined && typeof c.kds !== 'boolean') bad('attestedVerifier.collateral.kds must be a boolean');
  const file = fileCollateral(dir);
  if (c.cacheDir === undefined) {
    if (c.kds) bad('attestedVerifier.collateral.kds needs cacheDir (a writable directory separate from dir): without the authenticated cache an expired pre-seeded CRL would shadow a fresh AMD KDS answer (docs/network/attested-provider-collateral.md)');
    return file;
  }
  const cacheDir = path.resolve(absolute(c.cacheDir, 'attestedVerifier.collateral.cacheDir'));
  const within = (x, y) => x === y || x.startsWith(y + path.sep);
  if (within(cacheDir, dir) || within(dir, cacheDir)) bad('attestedVerifier.collateral.cacheDir must be separate from dir (neither inside the other): the cache writes, the pre-seed is read-only');
  const kds = c.kds ? http() : null;
  const upstream = { kind: kds ? 'pre-seed+kds' : 'pre-seed',
    chain: (product) => file.chain(product),
    vcek: kds ? layeredCollateral(file, kds).vcek : (product, chip, tcb, kdsPath) => file.vcek(product, chip, tcb, kdsPath),
    crl: kds ? layeredCollateral(kds, file).crl : (product) => file.crl(product) };
  return cachedCollateral({ dir: cacheDir, upstream, ...(roots ? { roots } : {}), ...(now ? { now } : {}) });
}

/** -> { mode, rpc, leaseReaderOptions, verifier|null, txBackend|null, describe }. testRoots: PROGRAMMATIC ONLY (tests); main.mjs never passes it. */
export function providerChainAuthority(cfg, { readFile = (p) => fs.readFileSync(p, 'utf8'), testRoots = null, collateral = null, verifyNow = null, log = () => {} } = {}) {
  const a = cfg.chainAuthority;
  if (a === undefined || a === null || a === 'quorum' || a === 'verifier') {
    if (cfg.attestedVerifier !== undefined) bad('attestedVerifier is set but chainAuthority is not "attested-verifier"');
    if (cfg.txBackend !== undefined) bad('txBackend is only used with chainAuthority "attested-verifier" (the RPC quorum submits as before): remove it');
    if (!Array.isArray(cfg.rpc) || cfg.rpc.length < 2) throw new Error('two or more RPC endpoints required');
    const opts = chainAuthorityOptions(cfg);
    return { mode: opts.authority === 'verifier' ? 'verifier' : 'quorum', rpc: cfg.rpc, leaseReaderOptions: opts, verifier: null, txBackend: null,
      describe: opts.authority === 'verifier' ? 'local loopback verifier' : `RPC quorum of ${cfg.rpc.length}` };
  }
  if (a !== 'attested-verifier') bad('chainAuthority must be quorum, verifier or attested-verifier');
  // one explicit authority: nothing that would read or write the chain another way may sit beside it
  if (cfg.rpc !== undefined) bad('rpc is not used with chainAuthority "attested-verifier" (one explicit authority, no fallback): remove it');
  if (cfg.chainVerifier !== undefined) bad('chainVerifier (a local verifier) is not used with chainAuthority "attested-verifier": remove it');
  const paid = (cfg.pricePerGiB6 || 0) > 0;
  if (paid && cfg.txBackend === undefined) bad('a paid provider with chainAuthority "attested-verifier" needs txBackend: the operator\'s own Base node (loopback or private IPv4 literal) for its on-chain sends; nothing is sent through any other server');
  if (!paid && cfg.txBackend !== undefined) bad('txBackend is set but this provider is not paid (it sends nothing on chain): remove it');
  const txBackend = paid ? providerTxBackend(cfg.txBackend) : null;
  const v = cfg.attestedVerifier;
  if (!plain(v)) bad('attestedVerifier: { unsafeSigner, replicas, collateral, reattestSec?, timeoutMs? } is required');
  for (const k of Object.keys(v)) if (!['unsafeSigner', 'replicas', 'collateral', 'reattestSec', 'timeoutMs'].includes(k)) bad(`attestedVerifier: unknown field ${k}`);
  if (!Array.isArray(v.replicas)) bad('attestedVerifier.replicas must be a list');
  const replicas = v.replicas.map((r, i) => {
    if (!plain(r)) bad(`attestedVerifier.replicas[${i}] must be an object`);
    for (const k of Object.keys(r)) if (!['url', 'configFile', 'measurements', 'minTcb'].includes(k)) bad(`attestedVerifier.replicas[${i}]: unknown field ${k} (trust roots and statuses are never configured)`);
    let config; try { config = JSON.parse(readFile(absolute(r.configFile, `attestedVerifier.replicas[${i}].configFile`))); } catch (e) { bad(`attestedVerifier.replicas[${i}].configFile: ${e.message}`); }
    return { url: r.url, config, measurements: r.measurements, minTcb: r.minTcb, ...(testRoots ? { roots: testRoots } : {}) };
  });
  const reattestMs = v.reattestSec === undefined ? undefined : Number(v.reattestSec) * 1000;
  // the cache authenticates with the same (test-only) roots and judges freshness at the same (test-only) clock as the verifier
  const verifier = createAttestedVerifier({ replicas, unsafeSigner: v.unsafeSigner,
    collateral: collateral || providerCollateral(v.collateral, { ...(testRoots ? { roots: testRoots } : {}), ...(verifyNow ? { now: verifyNow } : {}) }),
    allowTestRoots: !!testRoots, log, ...(verifyNow ? { verifyNow } : {}), ...(reattestMs !== undefined ? { reattestMs } : {}), ...(v.timeoutMs !== undefined ? { timeoutMs: v.timeoutMs } : {}) });
  return { mode: 'attested-verifier', rpc: [], leaseReaderOptions: { authority: 'verifier', verifier }, verifier, txBackend,
    describe: `attested remote verifier, ${replicas.length} replica(s) by failover (no quorum)${txBackend ? `; on-chain sends through the own backend ${txBackend.label} (submission and hints only)` : ''}` };
}

/**
 * The host-services admission runtime for a normalized hostServices block (host-services-config.mjs providerHostServices):
 * null when the policy is EXPLICITLY "off" (development only, as before). Under the RPC quorum: exactly the earlier runtime
 * (the policy's own RPC quorum). Under the attested authority: the SAME runtime and gate (anchor, current owner, sequence,
 * bans, persisted state) reading ONLY through one verified snapshot of the provider's attested client.
 */
// ttlMs: the runtime's decision cache (its own default when absent, as in production)
export function providerHostPolicyRuntime(hostServices, chainAuth, { stateDir, log = () => {}, fetch = globalThis.fetch, ttlMs } = {}) {
  const ttl = ttlMs === undefined ? {} : { ttlMs };
  if (!hostServices) return null;
  const env = hostServicesPolicyEnv(hostServices);
  if (!env) return null;
  const store = fileStore(path.join(stateDir, 'platform-host-policy.json'));
  if (chainAuth.mode !== 'attested-verifier') {
    const rt = createHostPolicyRuntime(resolveHostPolicyConfig({ env, chainId: 8453 }), { log, store, fetch, ...ttl });
    if (!rt) throw new Error('host services: the platform host policy did not resolve');
    return rt;
  }
  if (hostServices.rpcs?.length) bad('hostServices.platformHostPolicyRpcs is not used with chainAuthority "attested-verifier" (the policy reads through the attested verifier only): remove it');
  const p = hostServices.platformHostPolicy;
  if (plain(p) && ['rpcs', 'minAgree', 'chainAuthority', 'chainVerifier'].some((k) => p[k] !== undefined))
    bad('hostServices.platformHostPolicy names its own RPCs or chain authority: with chainAuthority "attested-verifier" the policy reads through the attested verifier only');
  const resolved = resolveHostPolicyConfig({ env, chainId: 8453 });
  // the policy DOCUMENTS still come from the mirrors (untrusted transport: each is checked against the anchored digest and
  // the book's current owner, read through the attested verifier)
  const rt = createHostPolicyRuntime(resolved, { log, store, fetch, ...ttl, snapshot: verifiedHostSnapshot({ verifier: chainAuth.verifier }) });
  if (!rt) throw new Error('host services: the platform host policy did not resolve');
  return rt;
}
