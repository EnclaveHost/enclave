// Candidate hs2 host-services.json for G4 (work/challenge-host-tls-20261021): the LIVE G3 config (47f3e1f5, root receipt
// g3-final-package/root-g3/result-upgrade-20261021T205710Z.json, receipt 3db1205d) with
//   (1) ONLY changed package pins replaced (service-tls; every other package is byte-identical), and
//   (2) service-tls.config.challenge ADDED: the pinned challenge origin front + the REVIEWED-candidate replica release pins
//       read from its manifest (certificate-release-prep/release/dist/dns.mjs.manifest.json aa1ebdb5).
// orders stays exactly as live ("held"). Nothing else changes.
//   node derive-config-g4.mjs <live config> <G4 windows stage dir> <release manifest> <tree> <out>
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto'; import { pathToFileURL } from 'node:url';
const [live, stage, manifest, tree, out] = process.argv.slice(2);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const LIVE_SHA = '47f3e1f56a4e232283b10641c03066616841d0da1286110961320c2e1e807518', MANIFEST_SHA = 'aa1ebdb591e15866d30061ae41704c6532ff6ec03a882f920c99058a3bd41bbf';
const text = fs.readFileSync(live); if (sha(text) !== LIVE_SHA) throw new Error('not the live G3 config');
const cfg = JSON.parse(text);
if (JSON.stringify(cfg, null, 2) + '\n' !== text.toString('utf8')) throw new Error('the live config does not round-trip byte-exact');
const mbytes = fs.readFileSync(manifest); if (sha(mbytes) !== MANIFEST_SHA) throw new Error('not the pinned release manifest');
const m = JSON.parse(mbytes);
const release = { dnsSha256: m.sha256, runtimeBundleSha256: m.runtimeBundleSha256 };
const pin = (role) => 'sha256:' + sha(fs.readFileSync(path.join(stage, 'packages', `${role}.package.json`)));
const changed = {};
for (const s of cfg.services) { const p = pin(s.role); if (p !== s.package) { changed[s.role] = { old: s.package, new: p }; s.package = p; } }
const st = cfg.services.find((s) => s.role === 'service-tls');
if (!st || st.config.challenge) throw new Error('need a live service-tls without challenge');
if (st.config.orders !== 'held') throw new Error('live orders are not "held"');
st.config.challenge = { tlsPort: 18291, frontPort: 18292, declarationFile: 'C:\\ProgramData\\Enclave\\network\\challenge\\challenge-front.json', release };
const bytes = Buffer.from(JSON.stringify(cfg, null, 2) + '\n');
// the tree's own validators (Windows paths mapped for this structural check; the runner re-validates on the host)
const imp = (p) => import(pathToFileURL(path.join(tree, p)).href);
const { validateHostServicesConfig } = await imp('network/host-services/runner.mjs');
const { hostChallengeName } = await imp('network/host-service-names.mjs');
const posix = (v) => (typeof v === 'string' && /^[A-Za-z]:\\/.test(v) ? '/' + v[0] + '/' + v.slice(3).replace(/\\/g, '/') : Array.isArray(v) ? v.map(posix)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, posix(x)])) : v);
const bound = validateHostServicesConfig(posix(JSON.parse(bytes))).services.find((s) => s.role === 'service-tls').config;
fs.writeFileSync(out, bytes);
console.log(JSON.stringify({ endpoint: cfg.host.endpoint, hostId: bound.hostId, challengeOrigin: 'https://' + hostChallengeName(bound.hostId, bound.zone), orders: bound.orders,
  changedPins: changed, challenge: st.config.challenge, configSha256: sha(bytes) }, null, 1));
