// ROOT/OPERATOR, OFFLINE. The role exports descriptorBytes() but has no command that prints them for signing; this is
// that missing step, built from the role's own functions in the pinned host-software tree. It never holds or asks for
// a key: the registry operator signs the printed bytes (EIP-191 personal_sign) with their own wallet, then `assemble`
// verifies the signature with the role's verifyDescriptor before writing descriptor.json.
//   node descriptor.mjs request  --host-software <dir> --package-dir <unpacked rc2> --endpoint <registered endpoint>
//                                --replica <r> --advertise https://<host>[:port] --operator 0x<registry operator>  > request.json
//   node descriptor.mjs assemble --host-software <dir> --request request.json --signature 0x<65 bytes> --out descriptor.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [cmd] = process.argv.slice(2);
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const die = (m) => { console.error(`descriptor: ${m}`); process.exit(1); };
const hs = arg('--host-software'); if (!hs || !['request', 'assemble'].includes(cmd)) die('usage: request|assemble --host-software <dir> ...');
const imp = (rel) => import(pathToFileURL(path.join(hs, rel)).href);
const role = await imp('network/host-services/storage-indexer-host.mjs');
const { hostIdOfEndpoint } = await imp('network/host-service-gate.mjs');
const { hashMessage } = await imp('node_modules/viem/_esm/index.js');

if (cmd === 'request') {
  const endpoint = role.canonicalHostEndpoint(arg('--endpoint') || ''); if (!endpoint) die('--endpoint is not a registered-endpoint form');
  const replica = arg('--replica') || '', advertiseURL = arg('--advertise') || '', operator = String(arg('--operator') || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(replica)) die('--replica: [a-z0-9][a-z0-9-]{0,30}');
  if (!/^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(advertiseURL)) die('--advertise: https://<host>[:port] (MISSING until a non-DigitalOcean ingress exists for it)');
  if (!/^0x[0-9a-f]{40}$/.test(operator)) die('--operator: the host REGISTRY operator address (gate-preflight.mjs prints it)');
  const dir = arg('--package-dir') || ''; const pin = 'sha256:' + createHash('sha256').update(fs.readFileSync(path.join(dir, 'MANIFEST.sha256'))).digest('hex');
  const pkg = role.verifyPackage(dir, pin);                                   // every package file verified against its manifest
  const hostId = hostIdOfEndpoint(endpoint);
  const descriptor = role.descriptorBytes({ operator, hostId, replica, packagePin: pin, advertiseURL, indexdSha256: pkg.indexdSha256 });
  console.log(JSON.stringify({ format: 'enclave-storage-indexer-descriptor-request/v1', endpoint, hostId, replica, packagePin: pin, advertiseURL, operator,
    descriptor, eip191Digest: hashMessage(descriptor), sign: 'personal_sign of the EXACT descriptor string by the registry operator; never by the admin or any other key' }, null, 1));
} else {
  const req = JSON.parse(fs.readFileSync(arg('--request') || '', 'utf8')); const sig = String(arg('--signature') || ''); const outFile = arg('--out');
  if (!outFile) die('--out descriptor.json');
  const x = JSON.parse(req.descriptor);
  if (role.descriptorBytes({ operator: x.operator, hostId: x.hostId, replica: x.replica, packagePin: x.package, advertiseURL: x.applicationAPI, indexdSha256: x.indexd?.sha256 }) !== req.descriptor
      || x.operator !== req.operator || x.hostId !== req.hostId || x.replica !== req.replica || x.package !== req.packagePin || x.applicationAPI !== req.advertiseURL)
    die('request.descriptor is not the role\'s canonical descriptor bytes for this request');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-descriptor-')), f = path.join(tmp, 'd.json');
  try {
    fs.writeFileSync(f, JSON.stringify({ descriptor: req.descriptor, signature: sig }));
    const v = await role.verifyDescriptor(f, { hostId: req.hostId, replica: req.replica, packagePin: req.packagePin, advertiseURL: req.advertiseURL });
    if (v.operator !== req.operator) die(`signed by ${v.operator}, not the requested registry operator ${req.operator}`);
    fs.writeFileSync(outFile, fs.readFileSync(f), { flag: 'wx', mode: 0o644 });   // never overwrites
    console.log(JSON.stringify({ written: outFile, operator: v.operator, hostId: req.hostId, replica: req.replica }));
  } catch (e) { die(e.message); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
