// The attestation dialog's verifier (src/attest-verify.js) against EyesOff's own production guest, captured from its
// public origin (tests/fixtures/attest-9eb4e600/SOURCE.md): the genuine document passes every check it can make with
// no platform API in the loop, and each substitution is refused at the check that names it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../src/attest-verify.js', import.meta.url), 'utf8'));
const A = globalThis.EnclaveAttest;
const fx = (f) => new URL(`./fixtures/attest-9eb4e600/${f}`, import.meta.url);
const capture = JSON.parse(readFileSync(fx('capture.json'), 'utf8'));
const vcek = new Uint8Array(readFileSync(fx('vcek-kds-amd.der')));
const foreignVcek = new Uint8Array(readFileSync(fx('foreign-genoa-vcek.der')));
const NOW = new Date(capture.capturedAt);
const nonce = Uint8Array.from(Buffer.from(capture.nonce, 'hex'));
const LABEL = '9eb4e600';
const EXPECT_QUERY = 'product=Turin&hwid=fa11afcf54ae9c53&fmc=1&bl=3&tee=2&snp=5&ucode=117';

const clone = () => JSON.parse(JSON.stringify(capture.doc));
const kds = (der = vcek) => async (q) => { kds.asked.push(q); return der; };
kds.asked = [];
const verify = (doc, o = {}) => A.verifyDomainDoc(doc, { nonce, fetchVcek: kds(), label: LABEL, now: NOW, ...o });

test('the genuine production guest passes every check this page can make', async () => {
  kds.asked = [];
  const v = await verify(clone());
  assert.equal(v.status, 'limited', v.reasons.join('\n'));
  for (const k of v.order) assert.equal(v.checks[k], true, `${k}: ${v.reasons.join('; ')}`);
  // the VCEK request the page makes is exactly KDS's own fields for this chip and TCB
  assert.deepEqual(kds.asked, [EXPECT_QUERY]);
  assert.equal(v.facts.product, 'Turin');
  assert.equal(v.facts.hostData, capture.deployment.slice(2));
  assert.equal(v.facts.appId, capture.expectedGuest.appId);
  // the runtime id recomputed here is the one the relay's prediction names (same canonical bytes as the Go/Node contract)
  assert.equal(v.facts.runtimeId, capture.expectedGuest.images[0].runtimeId);
  // the transport key the report binds is the one the origin's TLS certificate carried that day
  assert.equal(capture.doc.transportKey, capture.handshakeSpki);
  // the measurement is shown for comparison, never judged here; it is one the relay predicted for this deployment
  assert.ok(capture.expectedGuest.images.some((i) => i.measurement === v.facts.measurement));
  // and what was not checked is always said
  assert.deepEqual(v.omissions, ['crl', 'tcb-floor', 'measurement', 'handshake-key', 'self-served-page']);
});

test('a document answering another nonce is refused (no replay of an old report)', async () => {
  const other = new Uint8Array(32).fill(7);
  const v = await verify(clone(), { nonce: other });
  assert.equal(v.status, 'rejected');
  assert.equal(v.checks.document, false);
  // a replaying server that rewrites the echoed nonce cannot rewrite the signed report data
  const doc = clone();
  doc.nonce = Buffer.from(other).toString('hex');
  const w = await verify(doc, { nonce: other });
  assert.equal(w.checks.document, true);
  assert.equal(w.checks.binding, false);
  assert.equal(w.status, 'rejected');
});

test('another transport key, app or runtime is refused at its own check', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const doc = clone();
  doc.transportKey = Buffer.from(await crypto.subtle.exportKey('spki', kp.publicKey)).toString('base64');
  assert.equal((await verify(doc)).checks.binding, false, 'a man in the middle presenting its own key');

  const app = clone();
  app.appSha256 = 'ab'.repeat(32);
  assert.equal((await verify(app)).checks.app, false);

  const rt = clone();
  rt.runtime.version = '48.0.1';
  assert.equal((await verify(rt)).checks.binding, false, 'a different runtime than the report was made for');
  const wx = clone();
  wx.runtime.wx = 'off';
  assert.equal((await verify(wx)).checks.runtime, false);
});

test('the hardware half: a forged report, a foreign VCEK, no VCEK, an expired chain', async () => {
  // one measurement byte changed: still parses and binds, but AMD's signature no longer covers it
  const doc = clone();
  const r = Buffer.from(doc.report, 'base64');
  r[0x90] ^= 1;
  doc.report = r.toString('base64');
  const v = await verify(doc);
  assert.equal(v.checks.binding, true);
  assert.equal(v.checks.signature, false);
  assert.equal(v.status, 'rejected');

  // a genuine VCEK, but another processor's (and another product line's chain)
  const f = await verify(clone(), { fetchVcek: kds(foreignVcek) });
  assert.equal(f.checks.chain, false, f.reasons.join('; '));
  assert.equal(f.status, 'rejected');

  // no VCEK at all (a deployment with no egress): said plainly, never a pass
  const n = await verify(clone(), { fetchVcek: async () => null });
  assert.equal(n.status, 'unsigned');
  assert.equal(n.checks.signature, null);
  assert.match(n.reasons.at(-1), /NOT checked/);

  // the same evidence, judged after AMD's certificates have lapsed
  const late = await verify(clone(), { now: new Date('2049-01-01T00:00:00Z') });
  assert.equal(late.checks.chain, false);
});

test('host data must name the deployment the hostname spells', async () => {
  const v = await verify(clone(), { label: 'cc1f4f3f' });
  assert.equal(v.checks['host data'], false);
  assert.equal(v.status, 'rejected');
  // a custom domain spells no label: the check is skipped, not passed
  const c = await verify(clone(), { label: null });
  assert.equal(c.checks['host data'], null);
  assert.equal(c.status, 'limited');
});

// The retrieval the dialog runs, over real HTTP against a stand-in for this origin: the guest front's document path and
// this deployment's /attestation/vcek relay. Nothing else is served, so a pass cannot have come from anywhere else.
function standIn({ replay = false } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(u.pathname + u.search);
    if (u.pathname === '/.well-known/enclave-attestation') {
      const n = u.searchParams.get('nonce');
      // the genuine guest can only have answered the nonce it was asked; a replaying server echoes any nonce
      if (n !== capture.nonce && !replay) { res.writeHead(503); return res.end('{}'); }
      const doc = clone();
      if (replay) doc.nonce = n;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(doc));
    }
    if (u.pathname === '/attestation/vcek' && u.search === `?${EXPECT_QUERY}`) {
      res.writeHead(200, { 'content-type': 'application/pkix-cert' });
      return res.end(Buffer.from(vcek));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"not found"}}');
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, seen, origin: `http://127.0.0.1:${srv.address().port}/` })));
}

test('self-served retrieval end to end over HTTP, with no platform API', async () => {
  const { srv, seen, origin } = await standIn();
  try {
    const got = await A.selfServed({ origin, vcekUrl: new URL('attestation/vcek', origin).href, nonce, label: LABEL, now: NOW });
    assert.equal(got.verdict.status, 'limited', got.verdict.reasons.join('\n'));
    assert.deepEqual(seen, [`/.well-known/enclave-attestation?nonce=${capture.nonce}`, `/attestation/vcek?${EXPECT_QUERY}`]);
  } finally { srv.close(); }
});

test('a fresh nonce: the replaying stand-in is refused, the honest one has nothing to give', async () => {
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  const r = await standIn({ replay: true });
  try {
    const got = await A.selfServed({ origin: r.origin, vcekUrl: new URL('attestation/vcek', r.origin).href, nonce: fresh, label: LABEL, now: NOW });
    assert.equal(got.verdict.status, 'rejected');
    assert.equal(got.verdict.checks.binding, false);
  } finally { r.srv.close(); }
  const h = await standIn();
  try {
    assert.equal(await A.selfServed({ origin: h.origin, nonce: fresh, now: NOW }), null, 'no document: the caller falls back');
  } finally { h.srv.close(); }
});

test('an origin with no measured front (the app answers 404) yields null, not a verdict', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{}}'); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    assert.equal(await A.selfServed({ origin: `http://127.0.0.1:${srv.address().port}/` }), null);
  } finally { srv.close(); }
});

test('the bundled AMD roots are the pinned ones', async () => {
  // checkChain refuses a bundled ARK that does not hash to its pin, so a pass above already proves Turin's;
  // the parse helpers must also refuse garbage rather than throw past the verdict
  const bad = await verify({ ...clone(), report: 'AAAA' });
  assert.equal(bad.checks.report, false);
  assert.equal((await A.verifyDomainDoc(null, { nonce })).checks.document, false);
  assert.deepEqual(Object.keys(A.ARK_SHA256), ['Milan', 'Genoa', 'Turin']);
});
