// Shared fixture for the app-zone certificate tests (network/app-zone-challenge.mjs, relay/dns-relay.js
// APP_CHALLENGE_AUTH=attested-lease, isolation/m2/front/appzone.go). FIXTURES, stated as such:
//   - attestation documents are SYNTHETIC SEV-SNP reports (as test/dns-relay-attested.test.mjs builds them), judged by the
//     production judge in its explicit lab-unsigned mode (no AMD chain); every other check is the production code path;
//   - the chain is a deterministic in-memory ledger/registry/catalog served through a quorum-reader seam or JSON-RPC.
import {generateKeyPairSync, sign, createHash, randomBytes} from 'node:crypto';
import {ABI2, bind2, runtimeId} from '../isolation/contract/runtime.mjs';
import {appPushNonce, APP_PUSH_SIG_PREFIX, appChallengeName} from '../network/app-zone-challenge.mjs';

export const ZONE = 'app.enclave.host';
export const MEAS = '44'.repeat(48), APP = '55'.repeat(32);
export const DEP = '0x7ae476a3' + '11'.repeat(28), OTHER_DEP = '0x5b0c1d2e' + '22'.repeat(28);
export const OWNER = '0x' + '33'.repeat(20), RUNNER = '0x' + 'cd'.repeat(32), OPERATOR = '0x' + 'ab'.repeat(20);
export const APP_REF = 'catalog://0x' + '66'.repeat(32) + '/1', ENVELOPE = 'bafyfixtureenvelope';
export const PINS = {addressBook: '0x' + 'a1'.repeat(20), deployments: '0x' + 'd0'.repeat(20), registry: '0x' + 'e0'.repeat(20), catalog: '0x' + 'c0'.repeat(20)};
const JIT = {name: 'wasmtime', version: '48.0.1', execution: 'jit', targetIsa: 'x86_64', hostIsa: 'x86_64', cpuFeatures: 'baseline', wx: 'enforced', cache: 'none'};
const ST = `exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 seccomp=${'d4'.repeat(32)} scope=cgroup:/dom1`;

export const guestKey = () => { const k = generateKeyPairSync('ec', {namedCurve: 'P-256'}); return {priv: k.privateKey, spki: k.publicKey.export({type: 'spki', format: 'der'})}; };

export function report(binding, {measurement = MEAS, hostData = DEP} = {}) {
  const r = Buffer.alloc(0x4a0);
  r.writeUInt32LE(5, 0x00); r.writeBigUInt64LE(0x30000n, 0x08);
  binding.copy(r, 0x50); Buffer.from(APP, 'hex').copy(r, 0x70); Buffer.from(measurement, 'hex').copy(r, 0x90);
  Buffer.from(hostData.slice(2), 'hex').copy(r, 0xc0);
  Buffer.from('0103020500000075', 'hex').copy(r, 0x180); r[0x188] = 0x1a; r[0x189] = 0x02;
  return r;
}
// The attestation document a direct guest's front would hand out for (spki, nonce): the same shape as attestDocJSON.
export function attestDoc(spki, nonce, reportOpts = {}) {
  return {tier: 'T1', format: 'sev-snp-guest-domain-v1', report: report(bind2(spki, nonce, runtimeId(JIT)), reportOpts).toString('base64'),
    transportKey: spki.toString('base64'), appSha256: APP, nonce: Buffer.from(nonce).toString('hex'), abi: ABI2, runtime: JIT, runtimeSelfTest: ST};
}
// A v2 push exactly as isolation/m2/front/appzone.go sends it (field order, nonce, signature domain).
export function appPush(key, {op = 'set', value = createHash('sha256').update(randomBytes(8)).digest('base64url'), deploymentId = DEP, owner = OWNER,
  lease = {runner: RUNNER, operator: OPERATOR, appRef: APP_REF, envelope: ENVELOPE}, order, ts = Math.floor(Date.now() / 1000), name,
  reportOpts = {}, signer = key, docKey = key, nonceOverride, extra, tamper} = {}) {
  order ||= {url: 'https://ca.example/order/1', expires: Math.floor(Date.now() / 1000) + 3600};
  name ||= appChallengeName(deploymentId, ZONE);
  const p = {v: 2, op, name, value, deploymentId, owner, lease, order, ts, spki: key.spki.toString('base64')};
  const nonce = nonceOverride ?? appPushNonce(p);
  const doc = attestDoc(docKey.spki, nonce, reportOpts);
  let body = Buffer.from(JSON.stringify({...p, attestation: doc, ...extra}));
  const sig = sign('sha256', Buffer.concat([Buffer.from(APP_PUSH_SIG_PREFIX), body]), {key: signer.priv, dsaEncoding: 'der'}).toString('base64');
  if (tamper) body = Buffer.from(tamper(body.toString()));
  return {body, sig, name, value};
}

// ---- the chain: deterministic, mutable --------------------------------------------------------------------------
export function chainState() {
  const now = Math.floor(Date.now() / 1000);
  return {
    block: 52840000n, ids: [DEP, OTHER_DEP],
    deployments: {
      [DEP]: {id: DEP, owner: OWNER, appRef: APP_REF, configCid: ENVELOPE, isPublic: true, active: true, runner: RUNNER, runnerOperator: OPERATOR, leaseUntil: now + 3600},
      [OTHER_DEP]: {id: OTHER_DEP, owner: '0x' + '44'.repeat(20), appRef: APP_REF, configCid: 'other', isPublic: true, active: true, runner: RUNNER, runnerOperator: OPERATOR, leaseUntil: now + 3600},
    },
    hosts: {[RUNNER]: {operator: OPERATOR, active: true}},
    apps: {['0x' + '66'.repeat(32)]: {active: true}},
    versions: {['0x' + '66'.repeat(32) + '/1']: {yanked: false, approval: 1}},
  };
}
// One contract read on the state (the ABI functions network/app-zone-challenge.mjs uses), as a decoded value.
export function readContract(state, {address, functionName, args = []}) {
  address = address.toLowerCase();
  if (address === PINS.deployments) {
    if (functionName === 'count') return BigInt(state.ids.length);
    if (functionName === 'idAt') { const id = state.ids[Number(args[0])]; if (!id) throw Error('index out of range'); return id; }
    if (functionName === 'get') {
      const d = state.deployments[args[0].toLowerCase()];
      const z64 = '0x' + '0'.repeat(64), z40 = '0x' + '0'.repeat(40);
      if (!d) return {id: z64, owner: z40, appRef: '', ports: '', configCid: '', gpuMilli: 0, cpuMilli: 0, appPort: 0, isPublic: false, active: false, createdAt: 0n,
        rate: 0n, balance6: 0n, spent6: 0n, runner: z64, runnerOperator: z40, leaseUntil: 0n};
      return {...d, ports: '', gpuMilli: 0, cpuMilli: 1000, appPort: 443, createdAt: 1n, rate: 0n, balance6: 0n, spent6: 0n, leaseUntil: BigInt(d.leaseUntil)};
    }
  }
  if (address === PINS.registry && functionName === 'get') {
    const h = state.hosts[args[0].toLowerCase()] || {operator: '0x' + '0'.repeat(40), active: false};
    return {endpoint: 'https://fixture.invalid', repo: '', measurement: '0x' + '0'.repeat(64), operator: h.operator, registeredAt: 1n, lastSeen: 1n, active: h.active};
  }
  if (address === PINS.catalog) {
    if (functionName === 'getApp') { const a = state.apps[args[0].toLowerCase()] || {active: false};
      return {appId: args[0].toLowerCase(), publisher: '0x' + '0'.repeat(40), slug: '', name: '', description: '', versionCount: 1, createdAt: 1n, updatedAt: 1n, active: a.active}; }
    if (functionName === 'getVersion') { const v = state.versions[args[0].toLowerCase() + '/' + args[1]] || {yanked: true, approval: 2};
      return {cid: '', version: '1', vramMb: 0, gpuGflops: 0, memMb: 128, cpuGflops: 0, createdAt: 1n, verified: true, yanked: v.yanked, ports: '', approval: v.approval, config: ''}; }
  }
  throw Error(`unexpected contract read ${address} ${functionName}`);
}
// A quorum-reader seam (LeaseReader.agreed's contract): one block, the read function gets a client.
export function fakeReader(state, {fail = false} = {}) {
  return {calls: 0, async agreed(fn) {
    this.calls++;
    if (fail) throw Error('no fresh agreeing chain quorum');
    const client = {readContract: async (q) => readContract(state, q)};
    const value = await fn(client, state.block);
    return {...value, blockNumber: state.block, hash: '0x' + 'bb'.repeat(32), timestamp: Math.floor(Date.now() / 1000)};
  }};
}
