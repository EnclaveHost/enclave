// The provider's chain authority (network/wg-provider/main.mjs), as ONE explicit choice:
//   * absent / "quorum": the configured RPC quorum (cfg.rpc, two or more), exactly as before;
//   * "verifier": the local loopback verifier (network/lease-reader.mjs chainAuthorityOptions), exactly as before;
//   * "attested-verifier": a REMOTE chain verifier inside a SEV-SNP-attested measured guest (network/attested-verifier-client.mjs).
//     Every chain read of this provider - registry rows (hosts, provider records), app leases, owner signatures (EOA,
//     ERC-1271, SessionVault via the address book's factory, network/owner-signature.mjs) - goes through it, and NOTHING else:
//     an RPC list, a local verifier or a paid provider's on-chain writes beside it are refused (no mixed authority, no
//     fallback). The provider checks the attestation, not proofs: its answers are labelled attested-verifier, localProof false.
//
// cfg.attestedVerifier = { unsafeSigner, replicas: [{ url, configFile (absolute path of that replica's reviewed direct
//   config JSON), measurements: [96 hex], minTcb: { <product line>: { ...TCB fields } } }], collateral: { dir (absolute,
//   pre-seeded AMD files: amd/<product>-cert_chain.pem, amd/<product>-crl.der, vcek/<product>-<chip>-<tcb>.der),
//   kds?: true (also ask AMD KDS for what is not pre-seeded; off by default) }, reattestSec?, timeoutMs? }
// No configuration can name a trust root: AMD's pinned ARK is the only one (test roots are programmatic only).
import fs from 'node:fs';
import path from 'node:path';
import { chainAuthorityOptions } from '../lease-reader.mjs';
import { createAttestedVerifier } from '../attested-verifier-client.mjs';
import { fileCollateral, httpCollateral, layeredCollateral } from '../../verifier/collateral.mjs';

const bad = (m) => { throw new Error(`provider chain authority: ${m}`); };
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const absolute = (p, what) => { if (typeof p !== 'string' || !path.isAbsolute(p)) bad(`${what} must be an absolute path`); return p; };

/** The pre-seeded AMD collateral (read-only files), optionally layered over AMD KDS. */
export function providerCollateral(c, { http = httpCollateral } = {}) {
  if (!plain(c) || Object.keys(c).some((k) => !['dir', 'kds'].includes(k))) bad('attestedVerifier.collateral: { dir, kds? }');
  const dir = absolute(c.dir, 'attestedVerifier.collateral.dir');
  if (c.kds !== undefined && typeof c.kds !== 'boolean') bad('attestedVerifier.collateral.kds must be a boolean');
  const file = fileCollateral(dir);
  return c.kds ? layeredCollateral(file, http()) : file;
}

/**
 * -> { mode, rpc, leaseReaderOptions, verifier|null, describe }.
 * testRoots: PROGRAMMATIC ONLY (tests: a synthetic AMD-shaped chain); main.mjs never passes it.
 */
export function providerChainAuthority(cfg, { readFile = (p) => fs.readFileSync(p, 'utf8'), testRoots = null, collateral = null, log = () => {} } = {}) {
  const a = cfg.chainAuthority;
  if (a === undefined || a === null || a === 'quorum' || a === 'verifier') {
    if (cfg.attestedVerifier !== undefined) bad('attestedVerifier is set but chainAuthority is not "attested-verifier"');
    if (!Array.isArray(cfg.rpc) || cfg.rpc.length < 2) throw new Error('two or more RPC endpoints required');
    const opts = chainAuthorityOptions(cfg);
    return { mode: opts.authority === 'verifier' ? 'verifier' : 'quorum', rpc: cfg.rpc, leaseReaderOptions: opts, verifier: null,
      describe: opts.authority === 'verifier' ? 'local loopback verifier' : `RPC quorum of ${cfg.rpc.length}` };
  }
  if (a !== 'attested-verifier') bad('chainAuthority must be quorum, verifier or attested-verifier');
  // one explicit authority: nothing that would read or write the chain another way may sit beside it
  if (cfg.rpc !== undefined) bad('rpc is not used with chainAuthority "attested-verifier" (one explicit authority, no fallback): remove it');
  if (cfg.chainVerifier !== undefined) bad('chainVerifier (a local verifier) is not used with chainAuthority "attested-verifier": remove it');
  if ((cfg.pricePerGiB6 || 0) > 0) bad('a paid provider submits on-chain qualification transactions, which need a submission route this authority does not offer');
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
  const verifier = createAttestedVerifier({ replicas, unsafeSigner: v.unsafeSigner, collateral: collateral || providerCollateral(v.collateral),
    allowTestRoots: !!testRoots, log, ...(reattestMs !== undefined ? { reattestMs } : {}), ...(v.timeoutMs !== undefined ? { timeoutMs: v.timeoutMs } : {}) });
  return { mode: 'attested-verifier', rpc: [], leaseReaderOptions: { authority: 'verifier', verifier }, verifier,
    describe: `attested remote verifier, ${replicas.length} replica(s) by failover (no quorum)` };
}
