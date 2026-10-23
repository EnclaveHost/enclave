// LEGACY-CONTROL proof-key verification for metal0, before/after root's operator setProofKey (ROOT EXECUTES; read-only;
// prepared 2026-10-23; not run by its author).
//
// Why not metal/measured-control-verify.mjs: that verifier is for the DIRECT measured-control guest (cmdline
// metal.control=direct): it fetches /.well-known/enclave-control, a canonical statement whose keys.proof is bound into the
// report through the ABI/2 control role. metal0's control (ed918e4b and ee5df6b8 alike: cmdline "metal.mode=snp
// metal.isolation=snp-guest-per-app", no metal.control) runs the LEGACY path; gsup serves that route only from
// startDirectControl, so measured-control-verify against metal0 can only fail at its evidence step. Calling it here would be a
// guaranteed false REJECT, and calling the legacy result "measured-control verified" would be false; neither is done.
//
// What the legacy control CAN show, with existing code only, in three parts that must all pass:
//   A. HARDWARE (cryptographic): attest-control.mjs (frozen 2d407753): a FRESH quote over OUR nonce from the relay's
//      /v1/enclaves/metal0/attestation route, verified by verifier/consumer.mjs verifyMetalBox: AMD chain to the pinned ARK,
//      CRL, policy, VMPL 0, TCB floor, the full pinned measurement, report_data = sha256(transport SPKI T || nonce).
//   B. SUPERVISOR (relay-routed, NOT hardware-bound): GET https://api.enclave.host/t/metal0/v1/attestation - the supervisor's
//      own answer over the origin the relay attached with T. It must serve proofKey.address == the key root will register
//      (keySource in-enclave), a session key, and its stored attestation document must name the SAME transport key T (this
//      boot's agent key) and the SAME pinned measurement with report_data[0:32] = sha256(T). The proof key is NOT in any
//      report_data in the legacy path: this part rests on the relay routing /t/metal0 to the tunnel it attached with T.
//   C. REGISTRY (quorum): EnclaveRegistry.get(keccak("https://api.enclave.host/t/metal0")) through the pinned lease authority
//      (2 of 3 public RPCs agreeing): endpoint, operator 0xC9D0835C..., active; proofKey == the expected key -> MATCH,
//      otherwise PENDING (the state before the setProofKey lands).
// Status: rejected (any mismatch) | unknown (a read failed) | pending-registry (A+B pass, registry key not yet this boot's) |
// verified-legacy (all three). NEVER "verified" in the measured-control sense. Exit 0 / 2 (pending) / 1.
// Output: public evidence/recipient-proofkey-<UTC>.json (proof key, transport hash, served-document hash, registry fields;
// no chip id, no raw report); raw answers in evidence/private/*.json, mode 0600.
//   node verify-recipient-proofkey.mjs --target current|new --expect-proof-key 0x...
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as AC from './attest-control.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENDPOINT = 'https://api.enclave.host/t/metal0';
export const REGISTRY_ID = '0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be';   // keccak256(ENDPOINT) = both leases' runner
export const OPERATOR = '0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab';
export const REGISTRY_ADDRESS = '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac';                       // the control image's baked REGISTRY_ADDRESS
const PROD = '/home/steven/enclave-prod/metal-deabf8f90';
const MODS = ['client/lease-executor-authority.mjs', 'network/lease-gas-owner.mjs', 'client/lease-executor-client.mjs'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const LIMITS = [
  'legacy control: the proof key is not bound into any SNP report_data; part B rests on the relay routing /t/metal0 to the tunnel it attached with the fresh quote\'s transport key',
  'metal/measured-control-verify.mjs is NOT applicable: metal0 does not run the direct measured-control guest (no /.well-known/enclave-control statement exists)',
  'the stored document in part B is not fresh by itself; freshness comes from part A, tied to it by the same transport key and measurement',
];

/** The registry through the pinned lease authority (the preflight's method): -> {endpoint, operator, active, proofKey, measurement, block}. */
export async function quorumRegistry(id) {
  const REPO = AC.REPO;
  for (const m of MODS) if (sha(fs.readFileSync(path.join(REPO, m))) !== sha(fs.readFileSync(path.join(PROD, m)))) throw new Error(`${m} differs from the production release`);
  const imp = (m) => import(pathToFileURL(path.join(REPO, m)).href);
  const { createPublicClient, http } = await import(pathToFileURL(path.join(REPO, 'node_modules/viem/_esm/index.js')).href);
  const { verifiedLeaseAuthority } = await imp(MODS[0]);
  const { parseDeploymentRecord, REGISTRY_ABI } = await imp(MODS[1]);
  const deployment = parseDeploymentRecord(fs.readFileSync('/home/steven/enclave-prod/lease-gas/deployment.json'),
    { expectedDigest: 'sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089' });
  const urls = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base-mainnet.public.blastapi.io'];
  const a = await verifiedLeaseAuthority({ clients: urls.map((url) => createPublicClient({ transport: http(url, { timeout: 12000, retryCount: 0 }) })), deployment, quorum: 2 });
  if (String(a.pins.registry).toLowerCase() !== REGISTRY_ADDRESS) throw new Error(`the lease authority pins registry ${a.pins.registry}, not ${REGISTRY_ADDRESS}`);
  const e = await a.client.readContract({ address: a.pins.registry, abi: REGISTRY_ABI, functionName: 'get', args: [id] });
  return { endpoint: e.endpoint, operator: String(e.operator).toLowerCase(), active: e.active, proofKey: String(e.proofKey).toLowerCase(),
           measurement: e.measurement, block: { number: String(a.block.number), hash: a.block.hash }, agreeing: a.agreeing };
}

export async function run({ target, expectProofKey, deps = {} }) {
  const want = String(expectProofKey || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(want)) throw new Error('--expect-proof-key must be the 20-byte address root intends to register');
  if (!AC.TARGETS[target]) throw new Error('--target must be current or new');
  const pinned = AC.TARGETS[target].measurement;
  const out = { probe: 'verify-recipient-proofkey/1', at: (deps.now ? new Date(deps.now) : new Date()).toISOString(), target, expectedMeasurement: pinned,
                expectedProofKey: want, endpoint: ENDPOINT, registryId: REGISTRY_ID, expectedOperator: OPERATOR, parts: {}, reasons: [], limits: LIMITS };
  const raw = {};
  const done = (status) => Object.assign(out, { status, exitCode: { 'verified-legacy': 0, 'pending-registry': 2 }[status] ?? 1 });
  const reject = (part, why) => { out.parts[part] = 'FAIL'; out.reasons.push(`REJECT (${part}): ${why}`); return done('rejected'); };
  const unknown = (part, why) => { out.parts[part] = 'UNKNOWN'; out.reasons.push(`UNKNOWN (${part}): ${why}`); return done('unknown'); };
  // A. the fresh hardware quote (attest-control.mjs, frozen)
  let a;
  try { a = await (deps.probe || AC.probe)({ target }); } catch (e) { return { verdict: unknown('A hardware', e.message), raw }; }
  raw.attestation = a.raw;
  out.attestation = { pass: a.verdict.pass, status: a.verdict.status, required: a.verdict.required, observedMeasurement: a.verdict.observedMeasurement,
                      nonce: a.verdict.nonce, transportKeySha256: a.verdict.transportKeySha256, rawSha256: a.verdict.rawSha256, unavailable: a.verdict.unavailable };
  if (a.verdict.status === 'unavailable') return { verdict: unknown('A hardware', (a.verdict.reasons || []).join('; ').slice(0, 300)), raw };
  if (a.verdict.pass !== true || a.verdict.observedMeasurement !== pinned) return { verdict: reject('A hardware', `fresh quote did not verify for ${pinned.slice(0, 16)}… (${a.verdict.status}; failed ${JSON.stringify(a.verdict.failedChecks)})`), raw };
  const T = a.verdict.transportKeySha256;
  out.parts['A hardware'] = 'PASS'; out.transportKeySha256 = T;
  // B. the supervisor's own answer over the relay-routed origin
  let body;
  try {
    const r = await (deps.fetchImpl || globalThis.fetch)(`${ENDPOINT}/v1/attestation`, { redirect: 'error', headers: { accept: 'application/json' } });
    const text = await r.text(); if (text.length > 2 * 1024 * 1024) throw new Error('answer exceeds 2 MiB');
    raw.supervisor = { status: r.status, text };
    if (r.status !== 200) return { verdict: (r.status >= 500 || r.status === 429 ? unknown : reject)('B supervisor', `HTTP ${r.status}`), raw };
    out.servedDocumentSha256 = sha(Buffer.from(text)); body = JSON.parse(text);
  } catch (e) { return { verdict: unknown('B supervisor', e.message), raw }; }
  const served = String(body?.proofKey?.address || '').toLowerCase();
  out.servedProofKey = served || null;
  if (served !== want) return { verdict: reject('B supervisor', `the supervisor serves proof key ${served || 'none'}, not ${want}`), raw };
  if (body.proofKey.keySource !== 'in-enclave') return { verdict: reject('B supervisor', `proof key source ${body.proofKey.keySource}`), raw };
  if (!body?.sessionKey?.kid) return { verdict: reject('B supervisor', 'no session key'), raw };
  const doc = body?.enclave?.attestationDocument;
  if (!doc || doc.format !== 'sev-snp-guest-metal-v1' || typeof doc.transportKey !== 'string' || typeof doc.body !== 'string')
    return { verdict: reject('B supervisor', 'no stored metal SEV-SNP document beside the proof key'), raw };
  const spki = Buffer.from(doc.transportKey, 'base64'); const rep = Buffer.from(doc.body, 'base64');
  if (sha(spki) !== T) return { verdict: reject('B supervisor', 'the stored document names another transport key than the fresh quote (another boot or another box)'), raw };
  if (rep.length < 0xc0 || rep.subarray(0x90, 0xc0).toString('hex') !== pinned) return { verdict: reject('B supervisor', 'the stored document is another measurement'), raw };
  if (rep.subarray(0x50, 0x70).toString('hex') !== sha(spki)) return { verdict: reject('B supervisor', 'the stored document\'s report_data does not bind its transport key'), raw };
  out.parts['B supervisor'] = 'PASS (relay-routed origin; proof key not hardware-bound)'; out.sessionKid = body.sessionKey.kid;
  // C. the registry through the quorum
  let e;
  try { e = await (deps.registry || quorumRegistry)(REGISTRY_ID); } catch (err) { return { verdict: unknown('C registry', String(err.message).slice(0, 200)), raw }; }
  out.registry = e;
  if (!e || /^0x0{40}$/.test(e.operator)) return { verdict: reject('C registry', 'metal0 is not registered'), raw };
  if (String(e.endpoint).replace(/\/+$/, '') !== ENDPOINT) return { verdict: reject('C registry', `registered endpoint ${e.endpoint}`), raw };
  if (e.operator !== OPERATOR) return { verdict: reject('C registry', `operated by ${e.operator}, not ${OPERATOR}`), raw };
  if (e.active !== true) return { verdict: reject('C registry', 'registered but inactive'), raw };
  if (e.proofKey !== want) {
    out.parts['C registry'] = 'PENDING'; out.reasons.push(`PENDING (C registry): the registry's proof key ${e.proofKey} is not this boot's ${want} (setProofKey not landed yet)`);
    return { verdict: done('pending-registry'), raw };
  }
  out.parts['C registry'] = 'MATCH';
  return { verdict: done('verified-legacy'), raw };
}

export function persist(verdict, raw, dir = path.join(HERE, 'evidence')) {
  const stamp = verdict.at.replace(/[:.]/g, '');
  const priv = path.join(dir, 'private'); fs.mkdirSync(priv, { recursive: true, mode: 0o700 }); fs.chmodSync(priv, 0o700);
  const rawFile = path.join(priv, `recipient-proofkey-raw-${stamp}.json`);
  fs.writeFileSync(rawFile, JSON.stringify(raw), { mode: 0o600, flag: 'wx' }); fs.chmodSync(rawFile, 0o600);
  verdict.rawSha256 = sha(fs.readFileSync(rawFile));
  const pub = path.join(dir, `recipient-proofkey-${stamp}.json`);
  fs.writeFileSync(pub, JSON.stringify(verdict, null, 2) + '\n', { flag: 'wx' });
  return { pub, rawFile };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const target = arg('--target'), expectProofKey = arg('--expect-proof-key');
  AC.checkPins(); AC.checkImage(target);
  const { verdict, raw } = await run({ target, expectProofKey });
  const f = persist(verdict, raw);
  console.log(JSON.stringify({ status: verdict.status, parts: verdict.parts, proofKey: verdict.expectedProofKey, served: verdict.servedProofKey,
                               registryProofKey: verdict.registry?.proofKey ?? null, transportKeySha256: verdict.transportKeySha256 ?? null, verdict: f.pub }));
  process.exit(verdict.exitCode);
}
