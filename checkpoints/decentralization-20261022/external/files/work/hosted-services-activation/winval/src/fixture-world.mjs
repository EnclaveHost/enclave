// FIXTURE chain for the bounded Windows validation of the REAL runner and role packages (W6/W7): three loopback JSON-RPC
// servers answering the platform host policy facts (EnclaveAddressBook owner/anchor/registry, registry rows,
// EnclaveHostOwnership) with fresh blocks, a THROWAWAY admin key generated here, and a loopback control endpoint that
// signs + anchors a policy and drops the document into the host's importDir (the operator-import carrier). Nothing here
// touches a real chain, a real key or a production policy. Logic mirrors test/helpers/platform-policy-world.mjs.
//   node fixture-world.mjs <workDir> <packagesDir> <app-static.json>
//     writes <workDir>\world.json, host-services.json and the synthetic bootstrap data; control: POST /publish {deny}, /shutdown
//   node fixture-world.mjs --install <outDir> <stagePackagesDir> <app-static.json> <installedPackagesDir> <stateDir> <dataDir>
//     the same world for the ISOLATED REAL INSTALL (W9): host-services.json + bootstrap-manifest.json in <outDir> name the
//     install's own packages/state/data paths (install.ps1 -FixtureDir copies them in); the source artifacts and the policy
//     import carrier stay in <outDir>.
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { policyTypedData, policyDigest, encodeAnchor, ANCHOR_KEYS, POLICY_FORMAT } from '../../tree-r3/network/platform-host-policy.mjs';
import { artifactIdentity } from '../../tree-r3/sdk/storage/unixfs.mjs';

const INSTALL = process.argv[2] === '--install';
const [WORK, PKG, STATIC_FILE, I_PKG, I_STATE, I_DATA] = process.argv.slice(INSTALL ? 3 : 2);
const ZA = '0x' + '00'.repeat(20), Z32 = '0x' + '00'.repeat(32);
const BOOK = '0x' + 'b0'.repeat(20), REGISTRY = '0x' + 'e0'.repeat(20), OWNERSHIP = '0x' + 'c0'.repeat(20);
const ENDPOINT = 'https://validation.invalid/t/winval-20261021', HOST_ID = keccak256(toBytes(ENDPOINT)).toLowerCase();
const operator = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const admin = privateKeyToAccount(generatePrivateKey());                       // throwaway, fixture-only
const ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'addr', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'authority', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint64' }, { type: 'bytes32' }] },
  { type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [{ name: 'endpoint', type: 'string' }, { name: 'repo', type: 'string' },
    { name: 'measurement', type: 'bytes32' }, { name: 'operator', type: 'address' }, { name: 'registeredAt', type: 'uint64' }, { name: 'lastSeen', type: 'uint64' }, { name: 'active', type: 'bool' }] }] }];
const REGISTRY_KEY = toHex('registry', { size: 32 });
const state = { hi: ZA, lo: ZA };
const t0 = Date.now(), head = () => 1000 + Math.floor((Date.now() - t0) / 1000), byHash = new Map();
const blockAt = (n) => ({ number: toHex(n), hash: keccak256(toHex(n, { size: 32 })), parentHash: keccak256(toHex(n - 1, { size: 32 })), timestamp: toHex(Math.floor(t0 / 1000) + n - 1000), // a pure function of n: the 3 RPCs must agree
  transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0', logsBloom: '0x' + '00'.repeat(256), miner: ZA, nonce: '0x0000000000000000',
  sha3Uncles: Z32, stateRoot: Z32, receiptsRoot: Z32, transactionsRoot: Z32, extraData: '0x', size: '0x1', uncles: [], mixHash: Z32, totalDifficulty: '0x0' });
function answer({ method, params }) {
  if (method === 'eth_chainId') return '0x2105';
  if (method === 'eth_blockNumber') return toHex(head());
  if (method === 'eth_getBlockByNumber') { const n = params[0] === 'latest' ? head() : Number(params[0]); const b = blockAt(n); byHash.set(b.hash, n); return b; }
  if (method === 'eth_getBlockByHash') { const n = byHash.get(params[0]); return n === undefined ? null : blockAt(n); }
  if (method === 'eth_getCode') return '0x';
  if (method === 'eth_call') {
    const { to, data } = params[0], T = String(to).toLowerCase(), { functionName, args } = decodeFunctionData({ abi: ABI, data });
    let r;
    if (T === BOOK && functionName === 'owner') r = admin.address;
    else if (T === BOOK && functionName === 'addr') r = args[0] === ANCHOR_KEYS.hi ? state.hi : args[0] === ANCHOR_KEYS.lo ? state.lo : args[0] === REGISTRY_KEY ? REGISTRY : ZA;
    else if (T === REGISTRY && functionName === 'get') { const own = String(args[0]).toLowerCase() === HOST_ID;
      r = { endpoint: own ? ENDPOINT : '', repo: '', measurement: Z32, operator: own ? operator : ZA, registeredAt: 1n, lastSeen: 1n, active: own }; }
    else if (T === OWNERSHIP && functionName === 'authority') r = [ZA, ZA, 1n, Z32];
    else throw Error(`unscripted ${T} ${functionName}`);
    return encodeFunctionResult({ abi: ABI, functionName, result: r });
  }
  throw Error('unsupported ' + method);
}
const body = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString())); });
const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sha = (b) => createHash('sha256').update(b).digest('hex');

const rpcPorts = [];
const servers = [];
for (let i = 0; i < 3; i++) {
  const srv = http.createServer(async (req, res) => {
    let q; try { q = JSON.parse(await body(req)); } catch { res.writeHead(400); return res.end(); }
    const one = (x) => { try { return { jsonrpc: '2.0', id: x.id, result: answer(x) }; } catch (e) { return { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: String(e.message) } }; } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  });
  servers.push(srv); rpcPorts.push(await listen(srv));
}
const rpcs = rpcPorts.map((p) => `http://127.0.0.1:${p}`);
const dirs = INSTALL ? { data: WORK, importDir: path.join(WORK, 'policy-import'), artifacts: path.join(WORK, 'artifacts') }
  : { state: path.join(WORK, 'state'), data: path.join(WORK, 'data'), importDir: path.join(WORK, 'data', 'policy-import'), artifacts: path.join(WORK, 'data', 'artifacts') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
// where the SERVICE reads: the install's own directories (W9), or this work directory
const svc = INSTALL ? { packages: I_PKG, state: I_STATE, artifacts: path.join(I_DATA, 'artifacts'), manifest: path.join(I_DATA, 'bootstrap-manifest.json') }
  : { packages: PKG, state: dirs.state, artifacts: dirs.artifacts, manifest: path.join(dirs.data, 'bootstrap-manifest.json') };
let seq = 0, last = Z32;
async function publish(deny) {
  seq++;
  const p = { format: POLICY_FORMAT, chainId: 8453, book: BOOK, registry: REGISTRY, hostOwnership: OWNERSHIP, sequence: seq, issuedAt: Math.floor(Date.now() / 1000) - 5,
    expiresAt: 0, maxStaleSec: 0, previousDigest: last, mode: 'denylist', deny, admit: [] };
  const digest = policyDigest(p);
  fs.writeFileSync(path.join(dirs.importDir, `${digest}.json`), JSON.stringify({ document: JSON.stringify(p), signature: await admin.signTypedData(policyTypedData(p)) }));
  const a = encodeAnchor(digest); state.hi = a.hi; state.lo = a.lo; last = digest;
  return { digest, sequence: seq };
}
// synthetic bootstrap objects (public, generated here)
const objects = [];
for (const n of [1, 2]) {
  const bytes = Buffer.from(`enclave windows validation synthetic object ${n} ` + 'w'.repeat(4096 * n)), car = Buffer.concat([Buffer.from('car:'), bytes]);
  const cid = artifactIdentity(new Uint8Array(bytes)).cid;
  fs.writeFileSync(path.join(dirs.artifacts, `${cid}.bin`), bytes); fs.writeFileSync(path.join(dirs.artifacts, `${cid}.car`), car);
  objects.push({ cid, bytes: bytes.length, sha256: sha(bytes), carSha256: sha(car) });
}
fs.writeFileSync(path.join(dirs.data, 'bootstrap-manifest.json'), JSON.stringify({ verifiedObjects: objects }));
const pin = (role) => 'sha256:' + sha(fs.readFileSync(path.join(PKG, `${role}.package.json`)));
const appStatic = STATIC_FILE && fs.existsSync(STATIC_FILE) ? JSON.parse(fs.readFileSync(STATIC_FILE, 'utf8')).labels : {};
const ports = { dir: await freePort(), boot: await freePort(), dns: await freePort(), api: await freePort(), pm: await freePort() };
const cfg = { format: 'enclave-host-services/v1', host: { endpoint: ENDPOINT, publicEndpoints: {} },
  platformHostPolicy: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [], activation: 'required' }, platformHostPolicyRpcs: rpcs,
  platformHostPolicyCarriers: { importDir: dirs.importDir }, packagesDir: svc.packages, stateRoot: svc.state,
  services: [
    { role: 'directory-replica', package: pin('directory-replica'), heapMiB: 192, config: { port: ports.dir, bind: '127.0.0.1', stateDir: path.join(svc.state, 'directory-replica-state'),
      rpc: rpcs, addressBook: BOOK, authorityPins: { deployments: '0x' + 'd0'.repeat(20), registry: REGISTRY, connectivity: ZA, sessionVaultFactory: ZA }, checkers: ['0x' + '3c'.repeat(20)], peers: [] } },
    { role: 'bootstrap-replica', package: pin('bootstrap-replica'), heapMiB: 128, config: { port: ports.boot, bind: '127.0.0.1', directory: svc.artifacts, manifest: svc.manifest } },
    { role: 'route-dns', package: pin('route-dns'), heapMiB: 160, config: { dnsPort: ports.dns, bind: '127.0.0.1', apiPort: ports.api, apiBind: '127.0.0.1', zone: 'app.enclave.host',
      ipZone: 'ip.enclave.host', nsName: 'ns-winval.enclave.host', nsNames: ['ns-winval.enclave.host'], routeMapUrl: `http://127.0.0.1:${ports.dir}/v1/network/routes`,
      ...(Object.keys(appStatic).length ? { appStatic } : {}) } },
    { role: 'policy-mirror', package: pin('policy-mirror'), heapMiB: 128, config: { port: ports.pm, bind: '127.0.0.1', stateDir: path.join(svc.state, 'policy-mirror-state'),
      rpc: rpcs, minAgree: 2, book: BOOK, hostOwnership: OWNERSHIP, peers: [], importDir: dirs.importDir, syncSec: 5 } } ] };
fs.writeFileSync(path.join(WORK, 'host-services.json'), JSON.stringify(cfg, null, 2));
const first = await publish([{ kind: 'operator', value: '0x' + '5a'.repeat(20), reason: 'unrelated (fixture)' }]);
const control = http.createServer(async (req, res) => {
  const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.method === 'POST' && req.url === '/ban') return send(200, await publish([{ kind: 'operator', value: '0x' + '5a'.repeat(20), reason: 'unrelated (fixture)' }, { kind: 'operator', value: operator, reason: 'fixture ban' }]));
  if (req.method === 'POST' && req.url === '/unban') return send(200, await publish([{ kind: 'operator', value: '0x' + '5a'.repeat(20), reason: 'unrelated (fixture)' }]));
  if (req.method === 'POST' && req.url === '/shutdown') { send(200, { ok: true }); for (const s of [...servers, control]) { s.closeAllConnections?.(); s.close(); } setTimeout(() => process.exit(0), 200); return; }
  send(404, { error: 'not found' });
});
const controlPort = await listen(control);
fs.writeFileSync(path.join(WORK, 'world.json'), JSON.stringify({ pid: process.pid, rpcs, control: `http://127.0.0.1:${controlPort}`, endpoint: ENDPOINT, hostId: HOST_ID, operator,
  admin: admin.address, first, ports, appStatic }, null, 2));
setTimeout(() => process.exit(0), 30 * 60_000).unref?.();     // bounded lifetime: 30 minutes at most
setInterval(() => {}, 1 << 30);
