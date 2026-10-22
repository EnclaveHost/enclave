// Candidate hs2 host-services.json for G3: the LIVE r5 config (5768866d, root receipt compose5-review/root-r5) with
//   (1) ONLY changed package pins replaced (route-dns, A5 source; the others are byte-identical), and
//   (2) ONE appended service: service-tls with orders "held" (no CA contact until a reviewed config says "approved").
// No challengeTxtUpstream (its upstream is not decided), no hostServices/appStatic change, nothing else.
//   node derive-config-g3.mjs <live config> <new windows stage dir> <tree> <out>
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto'; import { pathToFileURL } from 'node:url';
const [live, stage, tree, out] = process.argv.slice(2);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const LIVE_SHA = '5768866dc1804435673174f673abfcd2aaf7da15f8fef18886c645ab9c94b87d';
const text = fs.readFileSync(live); if (sha(text) !== LIVE_SHA) throw new Error('not the live r5 config');
const cfg = JSON.parse(text);
if (JSON.stringify(cfg, null, 2) + '\n' !== text.toString('utf8')) throw new Error('the live config does not round-trip byte-exact');
const pin = (role) => 'sha256:' + sha(fs.readFileSync(path.join(stage, 'packages', `${role}.package.json`)));
const changed = {};
for (const s of cfg.services) { const p = pin(s.role); if (p !== s.package) { changed[s.role] = { old: s.package, new: p }; s.package = p; } }
if (cfg.services.some((s) => s.role === 'service-tls')) throw new Error('service-tls already configured');
const { keccak256, toBytes } = await import(pathToFileURL(path.join(tree, 'node_modules/viem/_esm/index.js')).href);
const hostId = keccak256(toBytes(cfg.host.endpoint)).toLowerCase();       // the EXACT registered endpoint bytes (B7)
cfg.services.push({ role: 'service-tls', package: pin('service-tls'), heapMiB: 128,
  config: { hostId, zone: 'app.enclave.host', httpPort: 18280, tlsPorts: { 'directory-replica': 18288, 'bootstrap-replica': 18289, 'policy-mirror': 18290 },
            ca: 'letsencrypt', orders: 'held' } });
const bytes = Buffer.from(JSON.stringify(cfg, null, 2) + '\n');
fs.writeFileSync(out, bytes);
console.log(JSON.stringify({ endpoint: cfg.host.endpoint, hostId, changedPins: changed, added: 'service-tls', configSha256: sha(bytes) }, null, 1));
