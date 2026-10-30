// Shared fixture for the Enclave Shield app-zone tests (network/app-zone-shield.mjs through network/app-zone-challenge.mjs and
// relay/dns-relay.js APP_CHALLENGE_SHIELD_POLICY). FIXTURES, stated as such - NOT Windows hardware:
//   - the TPM (EK chain, AK, quote, measured boot log naming the IDKS) is test/fixtures/vbs-synthetic.mjs's synthetic world,
//     driven through the node's REAL frame builder (windows/node/hvnode-evidence.mjs);
//   - the guest's VBS report is built and IDKS-signed here exactly as test/shield-dns-challenge.test.mjs builds it (the
//     OpenHCL report layout verifyVbsVmReport parses); a real report comes from the partition's paravisor;
//   - the chain is test/app-zone-fixture.mjs's deterministic ledger, with the deployment leased to the Shield host.
// Every check the replica makes (sessions, report signature, image/platform policy, lease, ban, catalog) is production code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes, createHash, sign, constants, generateKeyPairSync} from 'node:crypto';
import {keccak256, toBytes} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {haveOpenssl, tmpdir, makeVbsWorld, buildLog, buildQuote} from './fixtures/vbs-synthetic.mjs';
import {activateCredential} from '../relay/vbs-credential.mjs';
import {ABI2, bind2, runtimeId} from '../isolation/contract/runtime.mjs';
import {buildHvNodeFrame} from '../windows/node/hvnode-evidence.mjs';
import {attachMessage} from '../windows/node/shield-verdict.mjs';
import {appPushNonce, APP_PUSH_SIG_PREFIX, appChallengeName} from '../network/app-zone-challenge.mjs';
import * as F from './app-zone-fixture.mjs';

export {haveOpenssl};
const sha = (b) => createHash('sha256').update(b).digest(), hex = (b) => Buffer.from(b).toString('hex'), b64 = (b) => Buffer.from(b).toString('base64');
export const IMAGE = 'ab'.repeat(32), SHIELD_APP = 'cd'.repeat(32);
export const RUNTIME = {name: 'wasmtime', version: '48.0.1', execution: 'jit', targetIsa: 'x86_64', hostIsa: 'x86_64', cpuFeatures: 'host-detected', wx: 'enforced', cache: 'none'};
export const RID = runtimeId(RUNTIME);
// the Windows host: its registry endpoint (host id = keccak256(endpoint), the lease's runner) and its operator key
export const ENDPOINT = 'https://nucbox.shield.example', HOST_ID = keccak256(toBytes(ENDPOINT));
export const OTHER_ENDPOINT = 'https://other-nucbox.shield.example', OTHER_HOST_ID = keccak256(toBytes(OTHER_ENDPOINT));
export const operator = privateKeyToAccount('0x' + '42'.repeat(32)), stranger = privateKeyToAccount('0x' + '43'.repeat(32));
export const OPERATOR = operator.address.toLowerCase();
// the operator's pinned policy: the TPM roots of every given synthetic world (an operator admitting two TPM vendors)
export const policy = (...ws) => ({schema: 'enclave-shield-app-policy/1', ekRoots: ws.map((w) => w.ca.bundlePem.trimEnd()).join('\n') + '\n', platforms: 'attested',
  images: [{measurement: IMAGE, runtimeId: hex(RID)}]});
export const worlds = () => haveOpenssl ? {world: makeVbsWorld(tmpdir('az-shield-')), other: makeVbsWorld(tmpdir('az-shield-other-'))} : {};
export const shieldLease = (o = {}) => ({runner: HOST_ID, operator: OPERATOR, appRef: F.APP_REF, envelope: F.ENVELOPE, ...o});

// The chain: test/app-zone-fixture.mjs's, with both deployments leased to the Shield host (registry id HOST_ID, operator
// OPERATOR) and a second registered Shield host, OTHER_HOST_ID, under the same operator. The SNP host stays registered.
export function shieldChainState() {
  const s = F.chainState();
  for (const d of Object.values(s.deployments)) { d.runner = HOST_ID; d.runnerOperator = OPERATOR; }
  s.hosts[HOST_ID] = {operator: OPERATOR, active: true, endpoint: ENDPOINT};
  s.hosts[OTHER_HOST_ID] = {operator: OPERATOR, active: true, endpoint: OTHER_ENDPOINT};
  return s;
}
/** registryEntry for createAppZoneShield over the chain state ({endpoint, operator, active} | null) */
export const registryEntryOf = (state) => async (id) => {
  const h = state.hosts[String(id).toLowerCase()];
  return h && h.endpoint ? {endpoint: h.endpoint, operator: h.operator, active: h.active} : null;
};

// ---- the Windows host: a fake TPM over the synthetic world, driven by the node's real buildHvNodeFrame ----------------------
export function fakeTpm(w, {idksOf = w} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'az-shield-tpm-'));
  const L = buildLog({idksPub: idksOf.idks.publicKey});
  fs.writeFileSync(path.join(dir, 'boot.log'), L.log);
  return async (cmd) => {
    const [op, a, b] = cmd.split(' ');
    if (op === 'log') return {log: path.join(dir, 'boot.log')};
    if (op === 'activate') return {credential: hex(activateCredential(w.ek.privateKey, w.aik.name, Buffer.from(a, 'hex'), Buffer.from(b, 'hex')))};
    if (op === 'quote') { const Q = buildQuote({aikPriv: w.aik.privateKey, aikName: w.aik.name, pcrs: L.pcrs, pcr0: w.pcr0, extraData: Buffer.from(a, 'hex')});
                          return {attest: hex(Q.attest), sig: hex(Q.sig), 'aik-pub': hex(w.aik.tpmtPublic)}; }
    if (op === 'pcr') return {pcr: 'sha256 ' + hex(w.pcr0)};
    if (op === 'keys') return {'ek-cert': hex(w.ek.cert), 'aik-pub': hex(w.aik.tpmtPublic), 'aik-name': hex(w.aik.name)};
    throw new Error('tpm: ' + cmd);
  };
}
export const keysOf = (w) => ({ek: b64(w.ek.cert), ekChain: [], aikPub: b64(w.aik.tpmtPublic), aikName: b64(w.aik.name)});
/** One host session at a verifier `auth` ({challenge, attest}): the exchange windows/node/shield-sessions.mjs makes. */
export async function hostSession(auth, w, {signer = operator, idksOf = w, endpoint = ENDPOINT, party = null} = {}) {
  const hostId = keccak256(toBytes(endpoint));
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const spki = publicKey.export({type: 'spki', format: 'der'}), hostChallenge = randomBytes(32).toString('hex');
  const ch = await auth.challenge({hostId, endpoint, hostChallenge, keys: keysOf(w)});
  const nonce = Buffer.from(ch.nonce, 'base64');
  const frame = await buildHvNodeFrame({nonce, credentialBlob: Buffer.from(ch.credentialBlob, 'base64'), secret: Buffer.from(ch.secret, 'base64'),
    spki, privateKey, tpm: fakeTpm(w, {idksOf})});
  const operatorSig = await signer.signMessage({message: attachMessage({verifier: party ?? ch.party, hostId, endpoint, nonce: hex(nonce),
    transportKeySha256: hex(sha(spki)), ekCertSha256: hex(sha(w.ek.cert)), hostChallenge})});
  return {ch, attest: () => auth.attest({session: ch.session, rad: frame.rad, operatorSig})};
}

// ---- the guest: the OpenHCL VBS report its paravisor returns, and the m3 monitor's document around it ---------------------
export function vbsReport(input, {signer, image = IMAGE}) {
  const claims = Buffer.from(JSON.stringify({'user-data': input.toString('hex')})), env = Buffer.alloc(1236 + claims.length);
  const w32 = (o, n) => env.writeUInt32LE(n, o);
  w32(0, 0x414c4348); w32(4, 2); w32(8, env.length); w32(12, 2); w32(1216, 20 + claims.length); w32(1220, 1); w32(1224, 1); w32(1228, 1); w32(1232, claims.length); claims.copy(env, 1236);
  const r = env.subarray(32, 592); [560, 1, 1, 256, 0, 2].forEach((n, i) => r.writeUInt32LE(n, i * 4)); sha(claims).copy(r, 24); Buffer.from(image, 'hex').copy(r, 120);
  r.writeUInt32LE(5, 216); r.writeUInt32LE(0, 220); r.writeUInt32LE(2, 224); r.writeUInt32LE(0, 228);
  sign('sha256', r.subarray(0, 304), {key: signer, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32}).copy(r, 304);
  return env;
}
/** The Shield-direct front's attestation document for (spki, nonce) - the shape attestDocJSON returns on a partition. */
export function shieldDoc(spki, nonce, {signer, image = IMAGE, app = SHIELD_APP, runtime = RUNTIME, bindKey, bindNonce, launcherOnly = false,
  format = 'hyperv-partition-domain/v1', tier = 'T0-hv'} = {}) {
  const input = Buffer.concat([bind2(bindKey || spki, bindNonce || nonce, runtimeId(runtime)), Buffer.from(app, 'hex')]);
  const launcher = {format: 'hyperv-partition-domain/v1', signed: 'launcher'};
  const report = launcherOnly ? launcher : {...launcher, vbsVmReport: b64(vbsReport(input, {signer, image}))};
  return {abi: ABI2, format, tier, nonce: hex(nonce), transportKey: b64(spki), appSha256: app, runtime, report: b64(Buffer.from(JSON.stringify(report)))};
}
/** A v2 app-zone push exactly as isolation/m2/front/appzone.go sends it, carrying a Shield document. */
export function shieldPush(key, {signer, op = 'set', value = sha(randomBytes(8)).toString('base64url'), deploymentId = F.DEP, owner = F.OWNER,
  lease = shieldLease(), ts = Math.floor(Date.now() / 1000), name, nonceOverride, doc = {}} = {}) {
  const order = {url: 'https://ca.example/order/1', expires: Math.floor(Date.now() / 1000) + 3600};
  name ||= appChallengeName(deploymentId, F.ZONE);
  const p = {v: 2, op, name, value, deploymentId, owner, lease, order, ts, spki: key.spki.toString('base64')};
  const nonce = nonceOverride ?? appPushNonce(p);
  const body = Buffer.from(JSON.stringify({...p, attestation: shieldDoc(key.spki, nonce, {signer, ...doc})}));
  const sig = sign('sha256', Buffer.concat([Buffer.from(APP_PUSH_SIG_PREFIX), body]), {key: key.priv, dsaEncoding: 'der'}).toString('base64');
  return {body, sig, name, value};
}
