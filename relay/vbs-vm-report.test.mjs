import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, constants, createHash, randomBytes } from 'node:crypto';
import { verifyVbsVmReport } from './vbs-vm-report.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const measurement = 'a1'.repeat(32), nonce = randomBytes(64);
function fixture(editReport = () => {}, editClaims = () => {}) {
  const claims = { 'user-data': nonce.toString('hex') }; editClaims(claims);
  const bytes = Buffer.from(JSON.stringify(claims)), envelope = Buffer.alloc(1236 + bytes.length + 16);
  const w = (o, n) => envelope.writeUInt32LE(n, o);
  w(0, 0x414c4348); w(4, 2); w(8, 1236 + bytes.length); w(12, 2);
  w(1216, 20 + bytes.length); w(1220, 1); w(1224, 1); w(1228, 1); w(1232, bytes.length);
  bytes.copy(envelope, 1236);
  const r = envelope.subarray(32, 592);
  [560, 1, 1, 256, 0, 2].forEach((x, i) => r.writeUInt32LE(x, i * 4));
  createHash('sha256').update(bytes).digest().copy(r, 24);
  Buffer.from(measurement, 'hex').copy(r, 120);
  r.writeUInt32LE(5, 216); r.writeUInt32LE(2, 224);
  editReport(r);
  sign('sha256', r.subarray(0, 304), { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32 }).copy(r, 304);
  return envelope;
}
const check = (envelope, overrides = {}) => verifyVbsVmReport({ envelope, idksPublicKey: publicKey,
  expectedUserData: nonce, allowedMeasurements: [measurement], ...overrides });

test('accepts a signed image and exact guest input under an explicit key and pin', () => {
  assert.equal(check(fixture()).ok, true);
});
test('rejects replay for another challenge and a key from another boot', () => {
  assert.equal(check(fixture(), { expectedUserData: randomBytes(64) }).ok, false);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal(check(fixture(), { idksPublicKey: other.publicKey }).ok, false);
});
test('rejects validly signed debug, different VTL and outdated SVN reports', () => {
  for (const [offset, value] of [[220, 1], [216, 1], [224, 0]])
    assert.equal(check(fixture(r => r.writeUInt32LE(value, offset))).ok, false);
  assert.equal(check(fixture(), { minimumGuestSvn: 1 }).ok, false);
});
test('refuses absent and incorrect measurement pins, including a signed alternate image', () => {
  for (const pins of [undefined, [], ['b2'.repeat(32)]])
    assert.equal(check(fixture(), { allowedMeasurements: pins }).ok, false);
  assert.equal(check(fixture(r => r[120] ^= 1)).ok, false);
});
test('rejects changes to signature, claims, padding, formats and lengths', () => {
  for (const offset of [0, 4, 8, 12, 16, 20, 32, 36, 40, 44, 48, 52, 32 + 304,
    592, 1216, 1220, 1224, 1228, 1232, 1250]) {
    const envelope = fixture(); envelope[offset] ^= 1;
    assert.equal(check(envelope).ok, false, `changed offset ${offset}`);
  }
  const padded = fixture(); padded[padded.length - 1] = 1;
  assert.equal(check(padded).ok, false);
  for (const size of [0, 32, 560, 1235, 1236, 1237])
    assert.equal(check(fixture().subarray(0, size)).ok, false);
  assert.equal(check(Buffer.alloc(8193)).ok, false);
});
test('requires fixed-width guest input even when malformed claims are signed', () => {
  for (const value of ['', 'ff', null, nonce.toString('hex').toUpperCase()])
    assert.equal(check(fixture(() => {}, c => { c['user-data'] = value; })).ok, false);
});

const identity = { signer: '91'.repeat(32), productId: 1818455653, moduleId: 1734437220 };
const signedIdentity = (patch = {}, edit = () => {}) => fixture(r => {
  const i = { ...identity, ...patch };
  Buffer.from(i.signer, 'hex').copy(r, 152); r.writeUInt32LE(i.productId, 232); r.writeUInt32LE(i.moduleId, 236);
  r.writeUInt32LE(100, 228); edit(r);
});
test('release authority is pinned to the same measurement even with a genuine IDKS signature and high SVN', () => {
  const policy = { minimumGuestSvn: 13, imageIdentities: [{ measurement, identity }] };
  const accepted = check(signedIdentity(), policy);
  assert.equal(accepted.ok, true, accepted.reason); assert.deepEqual(accepted.identity, identity);
  for (const patch of [{ signer: '92'.repeat(32) }, { signer: '00'.repeat(32) }, { productId: 1 }, { moduleId: 1 }]) {
    const denied = check(signedIdentity(patch), policy);
    assert.equal(denied.ok, false); assert.equal(denied.checks.signature, true);
    assert.equal(denied.checks.svn, true); assert.equal(denied.checks['image-identity'], false);
  }
  const other = 'b2'.repeat(32);
  const crossed = { allowedMeasurements: [measurement, other], imageIdentities: [
    { measurement, identity: { ...identity, signer: '92'.repeat(32) } }, { measurement: other, identity }] };
  assert.equal(check(signedIdentity(), crossed).ok, false, 'cannot mix one measurement and another image authority');
  assert.equal(check(signedIdentity(), { ...policy, allowedMeasurements: [other] }).ok, false, 'identity never substitutes for measurement pin');
  const corrupt = signedIdentity(); corrupt[32 + 152] ^= 1;
  const forgery = check(corrupt, policy); assert.equal(forgery.checks.signature, false);
});
test('identity policy is optional only for legacy callers and otherwise fails closed on malformed pins', () => {
  assert.equal(check(fixture()).checks['image-identity'], undefined);
  const pin = { measurement, identity };
  for (const imageIdentities of [null, [], {}, [null], [identity], new Array(1),
    [{ ...pin, extra: true }], [{ ...pin, identity: { ...identity, extra: true } }],
    ...['', '00'.repeat(32), 'AB'.repeat(32), 0].map(signer => [{ ...pin, identity: { ...identity, signer } }]),
    ...[-1, 0x100000000, 1.5, '1', null].flatMap(n => ['productId', 'moduleId'].map(k => [{ ...pin, identity: { ...identity, [k]: n } }])),
    new Array(257).fill(pin)]) {
    const denied = check(signedIdentity(), { imageIdentities });
    assert.equal(denied.ok, false); assert.equal(denied.checks.inputs, false);
  }
});
