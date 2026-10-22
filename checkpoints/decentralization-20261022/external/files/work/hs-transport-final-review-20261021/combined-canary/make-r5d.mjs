// LOCAL only (reviewer 9d; root reruns it): the hs2 config for the DNS step (A5), from the r5 spec with compose5's OWN
// genConfig (source stage-tool.mjs 387bc5d1, bundled as fdd42acd), exactly like 605's reconstruct-config-r5.mjs. make-upgrade-bundle.py refuses any change
// beyond package pins, so this writes the config-only bundle itself; hs2-upgrade.ps1 b17360b2 applies it unchanged.
//   node make-r5d.mjs                                  -> r5d/host-services.r5d.json (+ its sha and the JSON diff vs r5)
//   node make-r5d.mjs --old-receipt-sha <hex> --out <dir>  -> the bundle: upgrade-manifest.json + config/host-services.json
//      (<hex> = receiptNew from the r5 upgrade's journal, printed in root-hs2-r5.py's result; known only after r5 ran)
// Spec changes, all for the single ca-east pin and nothing else:
//   hostServices {exits:[ca-east c4c7888e = 146.190.246.39], dns:{tcp,udp}=ports.dns 18153 (as stage-tool --dns), dnsGlobalPps:2000}: the 3 own labels in appStatic and
//     the loopback transport aggregate 2000/s, burst 4000 (= the pinned provider's global DNS limit x 1 exit);
//   dns.nsName / nsNames = what EVERY front's route-dns serves today (probe 18:11Z: NS_NAME ns-us-west, NS_NAMES the four
//     fronts), so the pinned front's SOA/NS answers do not change (r5 would serve ns-nucbox-k11-4, which is not delegated).
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto'; import { pathToFileURL } from 'node:url';
const W = '/home/steven/Documents/Codex/2026-10-18/wo/work', C5 = `${W}/host-service-tls-20261021/compose5`;
const R5 = `${W}/host-service-tls-20261021/upgrade-bundle-r5`, OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'r5d');
const SPEC = `${W}/host-service-tls-20261021/stage-r5/stage-r2/enclave-host-services-hs2-windows/config/spec.windows.json`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pin = (p, h) => { if (sha(fs.readFileSync(p)) !== h) throw new Error(`${p} is not ${h}`); };
pin(`${C5}/network/host-services/stage-tool.mjs`, '387bc5d1f624c602bd565fd90a7fb8b470442da09358612dfdcae03fbe56d9e8');   // the SOURCE (bundled as bin/stage-tool.mjs fdd42acd)
pin(`${R5}/upgrade-manifest.json`, '418ca1d166e63aedd5108e56e88336fb17d89867b15a318d27212d45ce481f7d');
pin(`${R5}/config/host-services.json`, '5768866dc1804435673174f673abfcd2aaf7da15f8fef18886c645ab9c94b87d');
const { genConfig } = await import(pathToFileURL(`${C5}/network/host-services/stage-tool.mjs`).href);
const listeners = 'tcp LISTEN 0 128 127.0.0.1:22 0.0.0.0:*';   // as 605's reconstruction: the capture only gates port conflicts
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const r5 = Buffer.from(JSON.stringify(genConfig(spec, listeners), null, 2) + '\n');
if (sha(r5) !== '5768866dc1804435673174f673abfcd2aaf7da15f8fef18886c645ab9c94b87d') throw new Error('the r5 spec no longer gives the r5 config');
const fronts = ['ns-us-west.enclave.host', 'ns-eu-central.enclave.host', 'ns-ap-southeast.enclave.host', 'ns-ca-east.enclave.host'];
const spec5d = { ...spec, dns: { ...spec.dns, nsName: 'ns-us-west.enclave.host', nsNames: fronts },
  hostServices: { exits: [{ providerId: 'c4c7888e4741dcbe2c092dd81e888bf7', address: '146.190.246.39' }], dns: { tcp: spec.ports.dns, udp: spec.ports.dns }, dnsGlobalPps: 2000 } };
const r5d = Buffer.from(JSON.stringify(genConfig(spec5d, listeners), null, 2) + '\n');
const a = JSON.parse(r5), b = JSON.parse(r5d), diff = [];
const walk = (x, y, p) => { if (JSON.stringify(x) === JSON.stringify(y)) return;
  if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y) && !(Array.isArray(x) && x.length !== y.length)) {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${p}.${k}`); }
  else diff.push({ path: p, r5: x, r5d: y }); };
walk(a, b, '$');
fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'host-services.r5d.json'), r5d);
const i = process.argv.indexOf('--old-receipt-sha'), o = process.argv.indexOf('--out');
const res = { r5ConfigSha: sha(r5), r5dConfigSha: sha(r5d), diff };
if (i > 0) {
  const receipt = String(process.argv[i + 1] || ''), out = process.argv[o + 1];
  if (!/^[0-9a-f]{64}$/.test(receipt) || o < 0 || !out || fs.existsSync(out)) throw new Error('--old-receipt-sha <64 hex> --out <new dir>');
  const m5 = JSON.parse(fs.readFileSync(`${R5}/upgrade-manifest.json`, 'utf8'));
  // every installed program file after r5 is asserted unchanged; nothing is replaced or added
  const unchanged = [...m5.unchanged, ...m5.replace.map((r) => ({ path: r.path, sha: r.new }))].sort((x, y) => (x.path < y.path ? -1 : 1));
  const manifest = { format: 'enclave-hs2-upgrade/v1', label: 'hs2', id: `hs2-a93a5663-cfg-${sha(r5d).slice(0, 8)}`, scripts: m5.scripts,
    replace: [], add: [], unchanged, config: { old: sha(r5), new: sha(r5d), changedPins: {} }, receipt: { old: receipt } };
  fs.mkdirSync(path.join(out, 'config'), { recursive: true });
  fs.writeFileSync(path.join(out, 'config', 'host-services.json'), r5d);
  fs.writeFileSync(path.join(out, 'upgrade-manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  res.bundle = out; res.manifestSha256 = sha(fs.readFileSync(path.join(out, 'upgrade-manifest.json')));
}
console.log(JSON.stringify(res, null, 1));
