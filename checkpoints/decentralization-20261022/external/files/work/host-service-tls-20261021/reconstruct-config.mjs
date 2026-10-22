// Reconstruct the live hs2 host-services.json (install.ps1: stage-tool gen-config --spec config/spec.windows.json; the
// listener capture only gates port conflicts) with the r3 tree's genConfig, and the r4 equivalent with compose4's genConfig.
import fs from 'node:fs'; import { createHash } from 'node:crypto'; import { pathToFileURL } from 'node:url';
const W = '/home/steven/Documents/Codex/2026-10-18/wo/work';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const listeners = 'tcp LISTEN 0 128 127.0.0.1:22 0.0.0.0:*';   // no conflict with 18153/18154/18188/18189/18190
async function gen(tree, spec) {
  const { genConfig } = await import(pathToFileURL(`${tree}/network/host-services/stage-tool.mjs`).href);
  return Buffer.from(JSON.stringify(genConfig(JSON.parse(fs.readFileSync(spec, 'utf8')), listeners), null, 2) + '\n');
}
const old = await gen(`${W}/hosted-services-activation/tree-final`, `${W}/hosted-services-activation/final-r3/stage-r2/enclave-host-services-hs2-windows/config/spec.windows.json`);
const neu = await gen(`${W}/host-service-tls-20261021/compose4`, `${W}/host-service-tls-20261021/stage-r4/stage-r2/enclave-host-services-hs2-windows/config/spec.windows.json`);
fs.writeFileSync(`${W}/host-service-tls-20261021/bundle-input/host-services.r3-reconstructed.json`, old);
fs.writeFileSync(`${W}/host-service-tls-20261021/bundle-input/host-services.r4-genconfig.json`, neu);
console.log(JSON.stringify({ r3Reconstructed: sha(old), matchesLive: sha(old) === 'bef2446a14750871e3a696fe9c317ac930b8f0f8c7246efd393a8f0206946124', r4GenConfig: sha(neu) }));
