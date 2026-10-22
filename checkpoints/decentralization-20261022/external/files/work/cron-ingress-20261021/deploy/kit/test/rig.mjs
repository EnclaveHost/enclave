// Shared fixture for the directory runtime tests. INPUTS are produced with the repo's signing helpers (fixture keys);
// the SYSTEM UNDER TEST is always a built bundle: ../enclave-directory.mjs (new, 2467cea0...: abe86262 + the route-record
// patch) or old/enclave-directory-cb9ff18.mjs (the runtime deployed on all four hosts), each hash-checked here.
// Inputs are signed with the helpers of the LIVE source commit abe86262 (../base, a git archive of it).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CAND = path.dirname(HERE);
const ENCLAVE = path.resolve(CAND, '../base');
const imp = p => import(pathToFileURL(path.join(ENCLAVE, p)).href);
const req = createRequire(path.join(ENCLAVE, 'package.json'));
const {privateKeyToAccount} = await import(pathToFileURL(req.resolve('viem/accounts')).href);
const {signProviderRecord, signQualification, providerIdFor, CHECKS} = await imp('network/provider-directory.mjs');
const {defaultNetworkPolicy, signNetworkPolicy} = await imp('network/network-policy.mjs');
const {signDelegation, signRoute, recordHash} = await imp('network/route-record.mjs');
const {signManagementRecord} = await imp('network/management-record.mjs');

export const sha = b => createHash('sha256').update(b).digest('hex');
export const BUNDLES = {
  new: {file: path.join(CAND, 'enclave-directory.mjs'), sha256: '2467cea0a26ab6c4f468a0e02594bb0af033e2abb598f4c490cefa54a5e433d4'},
  old: {file: path.join(HERE, 'old', 'enclave-directory-cb9ff18.mjs'), sha256: 'cb9ff1839ebbaaf2335174cbf29d86a8f4060160eb548ca250111e5a081d82e5'},
};
for (const [k, b] of Object.entries(BUNDLES)) if (sha(fs.readFileSync(b.file)) !== b.sha256) throw Error(`bundle ${k} hash mismatch`);
// Import a bundle as a fresh module instance (query string defeats the module cache) -> {runDirectory, createDirectoryServer}
let gen = 0;
export const loadBundle = kind => import(pathToFileURL(BUNDLES[kind].file).href + '?instance=' + (++gen));

const account = n => privateKeyToAccount('0x' + n.repeat(64));
export const owner = account('1'), operator = account('2'), checker = account('3'), stranger = account('4'), operator2 = account('5');
export const id = '0x' + 'ab'.repeat(32), runner = '0x' + 'cd'.repeat(32), deployments = '0x' + '05'.repeat(20), registry = '0x' + '86'.repeat(20);
// Production config schema (config-f6959cb.json keys): addressBook, authorityPins, bind, checkers, peers, port, rpc, stateDir.
// Public pins as deployed; RPC origins are unreachable fixtures (the tests run without network).
export function config({stateDir, port, peers = []}) {
  return {addressBook: '0xab214342d5A490150A4A977063A2f88E21F80907',
    authorityPins: {deployments: '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b', registry: '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac',
      connectivity: '0x5f8b636e0768e84bd47b736652030b65db615111', sessionVaultFactory: '0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c'},
    bind: '127.0.0.1', checkers: [checker.address.toLowerCase()], peers, port,
    rpc: ['https://rpc-a.fixture.invalid', 'https://rpc-b.fixture.invalid', 'https://rpc-c.fixture.invalid'], stateDir};
}
// The injected chain reader (runDirectory's documented test seam: refresh, registryEntries, bookAddress).
export function fakeReader(now = Date.now()) {
  const lease = {id, owner: owner.address, runner, chainId: 8453, deployments, runnerOperator: operator.address, active: true, isPublic: true,
    leaseUntil: now + 3600000, validUntil: now + 3600000};
  return {lease, authorityPins: {sessionVaultFactory: '0x' + '0'.repeat(40)}, refresh: async ids => ids.filter(x => x === id).map(() => ({...lease})),
    registryEntries: async (_r, ids) => ids.map(h => (h === runner ? {active: true, operator: operator.address} : null)),
    bookAddress: async () => registry, agreed: async () => { throw Error('no chain in fixture'); }};
}
export const providerAddress = '8.8.4.4';
export const providerRecord = (issuedAt, region = 'test', address = providerAddress) => ({version: 1, providerId: providerIdFor(operator.address, address), operator: operator.address.toLowerCase(),
  address, wgExitKey: Buffer.alloc(32, address === providerAddress ? 1 : 5).toString('base64'), wgGuardKey: Buffer.alloc(32, address === providerAddress ? 2 : 6).toString('base64'),
  ports: {exit: 51820, guard: 51821, control: 51822}, roles: ['guard', 'ingress', 'egress'], pricePerGiB6: 0, region, kind: 'community', hostId: runner,
  issuedAt, expiresAt: issuedAt + 1800000});
export const signProvider = (issuedAt, region, address) => signProviderRecord(operator, providerRecord(issuedAt, region, address));
export const signQual = (pr, issuedAt = Date.now() - 500, failed = {}) => signQualification(checker, {version: 1, providerId: pr.record.providerId, operator: pr.record.operator,
  address: pr.record.address, wgExitKey: pr.record.wgExitKey, wgGuardKey: pr.record.wgGuardKey, roles: pr.record.roles,
  checks: {...Object.fromEntries(CHECKS.map(k => [k, true])), ...failed}, issuedAt, expiresAt: issuedAt + 590000});
export const policy = nonce => ({...defaultNetworkPolicy(id), nonce, issuedAt: nonce});
export const signPolicy = (nonce, who = owner) => signNetworkPolicy(who, policy(nonce));
const routeKeys = generateKeyPairSync('ed25519');
export async function routePublication(pol, sequence, epoch, addresses = [providerAddress]) {
  const t = epoch ?? Date.now();
  const delegation = {version: 2, deploymentId: id, runner, chainId: 8453, deployments, policyHash: recordHash(pol), epoch: t, notBefore: t, expiresAt: t + 3600000,
    publicKey: routeKeys.publicKey.export({format: 'der', type: 'spki'}).toString('base64'), ipns: 'k51' + 'a'.repeat(50)};
  const authorization = await signDelegation(operator, delegation, t);
  const now = Date.now();
  const record = {version: 2, deploymentId: id, delegationHash: recordHash(delegation), sequence, issuedAt: now, expiresAt: now + 60000,
    routes: addresses.map((address, i) => ({circuit: (i ? 'e' : 'f').repeat(32), address, port: 443, transport: 'enclave-network'}))};
  return {version: 2, endpoint: 'https://old-control.example/t/host', policy: pol, bundle: {authorization, ...signRoute(routeKeys.privateKey, record)}};
}
export const managementRecord = (sequence, who = operator, address = '8.8.8.8') => signManagementRecord(who, {version: 1, runner, operator: who.address.toLowerCase(),
  chainId: 8453, deployments, address, port: 443, spkiSha256: '44'.repeat(32), sequence, issuedAt: sequence, expiresAt: sequence + 3600000}, Date.now());

// HTTP helper against a directory at 127.0.0.1:port -> {status, headers, body (parsed JSON or text)}
export function call(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({host: '127.0.0.1', port, method, path: p, agent: false, headers: {...(data !== undefined ? {'content-type': 'application/json'} : {}), ...headers}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let j = t; try { j = JSON.parse(t); } catch {} resolve({status: res.statusCode, headers: res.headers, body: j}); });
    });
    r.on('error', reject); if (data !== undefined) r.write(data); r.end();
  });
}
// Replay floors as stored: route-floors/<id>.json + managementFloors inside public-records.json.
export function stateSummary(stateDir) {
  const rec = JSON.parse(fs.readFileSync(path.join(stateDir, 'public-records.json'), 'utf8'));
  const floorsDir = path.join(stateDir, 'route-floors');
  const floors = fs.existsSync(floorsDir) ? Object.fromEntries(fs.readdirSync(floorsDir).filter(f => f.endsWith('.json')).map(f => [f, JSON.parse(fs.readFileSync(path.join(floorsDir, f), 'utf8'))])) : {};
  return {keys: Object.keys(rec).sort(), providers: Object.keys(rec.providers || {}).length, policies: Object.fromEntries(Object.entries(rec.policies || {}).map(([k, v]) => [k, v.envelope.policy.nonce])),
    publications: Object.keys(rec.publications || {}).length, management: Object.keys(rec.management || {}).length, managementFloors: rec.managementFloors || null, floors};
}
// A provider record that needs NO chain read (kind 'enclave', hostId null): writable through the real CLI runtime, whose
// chain reader has no network in the fixture.
export const signEnclaveProvider = (issuedAt, address = '1.0.0.1', region = 'live') => signProviderRecord(operator2, {version: 1,
  providerId: providerIdFor(operator2.address, address), operator: operator2.address.toLowerCase(), address,
  wgExitKey: Buffer.alloc(32, 3).toString('base64'), wgGuardKey: Buffer.alloc(32, 4).toString('base64'), ports: {exit: 51820, guard: 51821, control: 51822},
  roles: ['guard'], pricePerGiB6: 0, region, kind: 'enclave', hostId: null, issuedAt, expiresAt: issuedAt + 1800000});
