// LOCAL ONLY: canonical main's authority-profile + contract-pins validators over the repo's reviewed files (no network).
import fs from 'node:fs'; import { createHash } from 'node:crypto';
const E = '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/';
const ap = await import(E + 'network/authority-profile.mjs');
const out = {};
const pb = fs.readFileSync(E + 'contracts/deployments/network-profile-base.json');
try { const d = ap.profileDigest(pb); const r = ap.parseProfile(pb, { expectedDigest: d }); out.profile = { file: 'contracts/deployments/network-profile-base.json', sha256: createHash('sha256').update(pb).digest('hex'), digest: d, canonical: true, chainId: r.profile.chainId, contracts: Object.fromEntries(Object.entries(r.profile.contracts || {}).map(([k, v]) => [k, v.address])) }; }
catch (e) { out.profile = { error: e.message }; }
for (const f of ['contract-pins-production-base.json', 'contract-pins-base.json']) {
  const b = fs.readFileSync(E + 'contracts/deployments/' + f, 'utf8');
  try { const p = ap.validateContractPins(JSON.parse(b.replace(/^﻿/, ''))); out[f] = { sha256: createHash('sha256').update(b).digest('hex'), registry: p.registry ?? p.contracts?.registry?.address ?? p.contracts?.registry, keys: Object.keys(p.contracts || p) }; }
  catch (e) { out[f] = { error: e.message }; }
}
try { const rt = await import(E + 'relay/network-runtime.bundle.mjs'); if (out.profile.digest) { const { profile } = ap.parseProfile(pb, { expectedDigest: out.profile.digest }); out.shieldRegistryBinding = rt.shieldRegistryBinding(profile); } } catch (e) { out.shieldRegistryBinding = { error: e.message }; }
console.log(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? String(v) : v, 1));
