// Parser-only certificate-shaped envelopes, not signed certificates. The
// companion integration test supplies real synthetic X.509 signatures.
import assert from 'node:assert/strict';
import {parseAvfExtension, extensionValue, AVF_MAX_CERT_BYTES, AVF_MAX_COMPONENTS,
  AVF_MAX_CHAIN_CERTS, verifyAvfEvidence} from '../../relay/avf-verify.mjs';

const enc = (tag, body) => {
  const count = []; let n = body.length;
  if (n < 128) count.push(n);
  else {while (n) {count.unshift(n & 255); n = Math.floor(n / 256);} count.unshift(0x80 | count.length);}
  return Buffer.concat([Buffer.from([tag, ...count]), body]);
};
const seq = (...parts) => enc(0x30, Buffer.concat(parts));
const octet = b => enc(4, b), utf8 = s => enc(12, Buffer.from(s));
const integer = bytes => enc(2, Buffer.from(bytes));
const yes = enc(1, Buffer.from([255])), no = enc(1, Buffer.from([0]));
const oid = Buffer.from('060b2b06010401d67902011d01', 'hex');
const challenge = octet(Buffer.alloc(32, 1)), code = octet(Buffer.alloc(32, 2)), auth = octet(Buffer.alloc(64, 3));
const component = (...p) => seq(...(p.length ? p : [utf8('apk:anchor'), integer([1]), code, auth]));
const value = (flag = yes, comps = seq(component())) => seq(challenge, flag, comps);
const wrapExtensions = (...exts) => seq(seq(enc(0xa3, seq(...exts))), seq(), enc(3, Buffer.from([0])));
const wrap = (v, id = oid) => wrapExtensions(seq(id, octet(v)));
const refuse = b => assert.throws(() => parseAvfExtension(b));
const good = wrap(value());
assert.equal(parseAvfExtension(good).isVmSecure, true);
assert.equal(parseAvfExtension(wrap(value(no))).isVmSecure, false);
assert.equal(parseAvfExtension(wrap(value(yes, seq(component(utf8('apk:anchor'), integer([0,128]), code, auth))))).components[0].securityVersion, 128n);

for (const flag of [enc(1, Buffer.alloc(0)), enc(1, Buffer.from([0,255])), enc(1, Buffer.from([1])), enc(0x21, Buffer.from([255]))])
  refuse(wrap(value(flag)));
for (const version of [[], [255], [128], [0,1], [0,0], [0,...Array(32).fill(128)]])
  refuse(wrap(value(yes, seq(component(utf8('apk:anchor'), integer(version), code, auth)))));
for (const name of [Buffer.alloc(0), Buffer.from([0xc0,0xaf]), Buffer.from('apk:\0anchor'), Buffer.from('apk:\nanchor'), Buffer.alloc(1025, 97)])
  refuse(wrap(value(yes, seq(component(enc(12,name), integer([1]), code, auth)))));
refuse(wrap(seq(challenge, yes)));
refuse(wrap(seq(challenge, yes, seq(component()), enc(5,Buffer.alloc(0)))));
refuse(wrap(value(yes, seq(component(utf8('apk:anchor'), integer([1]), code)))));
refuse(wrap(value(yes, seq(component(utf8('apk:anchor'), integer([1]), code, auth, code)))));
refuse(wrap(value(yes, seq(enc(4, component())))));
refuse(wrap(enc(0x31, value())));
refuse(wrap(Buffer.concat([value(), Buffer.from([0])])));
refuse(Buffer.concat([good, Buffer.from([0])]));
for (let n = 0; n < good.length; n++) refuse(good.subarray(0,n));

// Invalid lengths include values which previously wrapped signed-32 arithmetic.
// This fixture runs in a killable subprocess so a walker regression cannot hang
// the test runner by looping over a backwards/zero-progress element.
for (const bad of ['3080', '308100', '30810100', '3082008000', '3084ffffffff',
  '308480000000', '308401', '30850000000001', '30063084ffffffff']) refuse(wrap(Buffer.from(bad,'hex')));
// A child can fit inside the certificate while overrunning its OWN parent.
refuse(seq(seq(Buffer.from([0xa3,4,0x30,0])),seq(),enc(3,Buffer.from([0]))));
refuse(wrapExtensions(seq(oid,octet(value())),seq(oid,octet(value(no)))));
refuse(wrapExtensions(seq(oid,no,octet(value())))); // DEFAULT FALSE must be absent in DER
assert.equal(parseAvfExtension(wrapExtensions(seq(oid,yes,octet(value())))).isVmSecure,true);
// Nonminimal and unterminated OID arcs must not alias the attestation OID.
refuse(wrap(value(),enc(6,Buffer.concat([oid.subarray(2),Buffer.from([0x80])]))));
refuse(wrap(value(),enc(6,Buffer.concat([oid.subarray(2,3),Buffer.from([0x80]),oid.subarray(3)]))));
const longFirst = Buffer.from('0603883703','hex'); // OID 2.999.3: first subidentifier is base-128 too
assert.deepEqual(extensionValue(wrap(value(),longFirst),'2.999.3'),value());

assert.throws(() => parseAvfExtension(Buffer.alloc(AVF_MAX_CERT_BYTES + 1)), /size limit/);
refuse(wrap(value(yes,seq(...Array.from({length:AVF_MAX_COMPONENTS + 1},()=>component())))));
assert.equal(verifyAvfEvidence({chain:Array(AVF_MAX_CHAIN_CERTS + 1).fill(Buffer.alloc(0))}).ok,false);
assert.match(verifyAvfEvidence({chain:[Buffer.alloc(AVF_MAX_CERT_BYTES + 1),Buffer.alloc(0)]}).reasons[0],/size/);
console.log('avf-der-malformed: PASS');
