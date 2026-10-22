// ROOT ONLY, OFFLINE. Renders host.json AND replica.env from ONE public input file, so the two never disagree (the
// package's template defaults pgBin to Debian's /usr/lib/postgresql/18/bin while preflight reads PG_BIN from
// replica.env: an Arch host such as metal0's host OS uses /usr/bin). host.json is accepted only if the ROLE's own
// validateConfig accepts it; replica.env has exactly the 8 keys the package's load_env allows. Refuses (never invents):
// a missing value, a placeholder, a DigitalOcean failure domain, an advertise URL known to resolve only to DigitalOcean.
//   node render-config.mjs --host-software <dir> --inputs inputs.json --out <dir>     (writes host.json, replica.env; never overwrites)
// inputs.json: { endpoint, replica, advertiseURL, pgBin, [pgLibDir], hostSoftwareDir, packageDir, platformHostPolicy:
//                "production", failureDomain: { site, provider, power } }
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const die = (m) => { console.error(`render-config: ${m}`); process.exit(1); };
const hs = arg('--host-software'), outDir = arg('--out'); if (!hs || !outDir || !arg('--inputs')) die('--host-software <dir> --inputs inputs.json --out <dir>');
const imp = (rel) => import(pathToFileURL(path.join(hs, rel)).href);
const role = await imp('network/host-services/storage-indexer-host.mjs');
const { hostIdOfEndpoint } = await imp('network/host-service-gate.mjs');
const inp = JSON.parse(fs.readFileSync(arg('--inputs'), 'utf8'));
// names that resolve ONLY to the four DigitalOcean machines today (work/claude-storage-hosted-placement-result.txt section 1)
const DO_ONLY = ['sia.enclave.host', 'ipfs.enclave.host'];
const need = ['endpoint', 'replica', 'advertiseURL', 'pgBin', 'hostSoftwareDir', 'packageDir', 'platformHostPolicy'];
for (const k of need) if (inp[k] === undefined || inp[k] === null || inp[k] === '') die(`MISSING ${k}: no value is invented`);
const fd = inp.failureDomain || {};
for (const k of ['site', 'provider', 'power']) if (!fd[k] || typeof fd[k] !== 'string') die(`MISSING failureDomain.${k}`);
const flat = JSON.stringify(inp);
if (/@[A-Z_]+@|<PLACEHOLDER|TODO|CHANGEME/.test(flat)) die('a placeholder is left in the inputs');
if (/digitalocean/i.test(fd.provider)) die('failureDomain.provider names DigitalOcean: DigitalOcean machines are transport-only');
for (const v of Object.values(fd)) if (/[`$;\n\r]/.test(v)) die('failure-domain values must not contain ` $ ; or newlines (replica.env syntax)');
const adv = new URL(inp.advertiseURL); if (DO_ONLY.includes(adv.hostname)) die(`${adv.hostname} resolves only to DigitalOcean today: the replica URL needs a non-DigitalOcean ingress`);
if (path.resolve(inp.hostSoftwareDir) !== path.resolve(hs)) die('hostSoftwareDir must be the --host-software tree this renders against');
if (inp.hostSoftwareDir.startsWith('/home/')) die('hostSoftwareDir under /home is unreadable to the unit (ProtectHome=yes): install it under /opt');
const manifest = 'sha256:' + createHash('sha256').update(fs.readFileSync(path.join(inp.packageDir, 'MANIFEST.sha256'))).digest('hex');
role.verifyPackage(inp.packageDir, manifest);
if (!fs.existsSync(path.join(inp.pgBin, 'postgres'))) console.error(`render-config: WARNING ${inp.pgBin}/postgres absent HERE (render may run off-host; the package preflight checks it on the host)`);
const r = inp.replica;
const host = { format: role.CONFIG_FORMAT, host: { endpoint: inp.endpoint }, platformHostPolicy: inp.platformHostPolicy, replica: r,
  package: { dir: inp.packageDir, manifest }, pgBin: inp.pgBin, ...(inp.pgLibDir ? { pgLibDir: inp.pgLibDir } : {}),
  stateRoot: '/var/lib/enclave-storage-indexer', runtimeDir: '/run/enclave-storage-indexer', credentialsDir: `/run/credentials/enclave-storage-indexer-host@${r}.service`,
  descriptorFile: `/etc/enclave-storage-indexer/${r}/descriptor.json`, adminAddress: '127.0.0.1:9980', appAddress: '127.0.0.1:9982', advertiseURL: inp.advertiseURL };
const v = role.validateConfig(host);                                          // the role's own rules, or this throws
const env = { REPLICA: r, ADVERTISE_URL: inp.advertiseURL, ENCLAVE_HOST_ID: hostIdOfEndpoint(v.host.endpoint), FAILURE_DOMAIN_SITE: fd.site,
  FAILURE_DOMAIN_PROVIDER: fd.provider, FAILURE_DOMAIN_POWER: fd.power, PG_BIN: inp.pgBin, ENCLAVE_HOST_SOFTWARE: inp.hostSoftwareDir };
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'host.json'), JSON.stringify(host, null, 1) + '\n', { flag: 'wx' });
fs.writeFileSync(path.join(outDir, 'replica.env'), Object.entries(env).map(([k, x]) => `${k}=${x}`).join('\n') + '\n', { flag: 'wx' });
console.log(JSON.stringify({ written: [path.join(outDir, 'host.json'), path.join(outDir, 'replica.env')], hostId: env.ENCLAVE_HOST_ID, packagePin: manifest }));
