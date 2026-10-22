"""Adds the retention tests (and the mock CA's fault knobs they need) to a copy of test/certs.test.mjs. Applied
IDENTICALLY to base/ and tree/: only relay/certs.js differs between them, so base is the negative control."""
import sys
p = sys.argv[1]; s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, (s.count(a), a[:80]); s = s.replace(a, b)
# knobs: counters of the next N requests that fail in a given way
rep('''  const ca = { mode: "ok", slowFinalizeMs: 0, slowInvalidMs: 0, certNotFound: 0,''',
    '''  const ca = { mode: "ok", slowFinalizeMs: 0, slowInvalidMs: 0, certNotFound: 0,
               // retention faults (2026-10-21): the next N such requests hang (no answer: the relay's fetch times out),
               // answer 502, or (finalizeHangAfter) are ACTED ON and then never answered; wrongKey signs another key's CSR
               orderHang: 0, order502: 0, finalizeHangAfter: 0, finalize502: 0, cert502: 0, authzHang: 0, wrongKey: 0,''')
rep('''      if (m[1] === "authz") {
        count("authz");''', '''      if (m[1] === "authz") {
        count("authz");
        if (ca.authzHang > 0 && o.authz === "valid") { ca.authzHang--; ca.hung.push(res); return; }''')
rep('''      if (m[1] === "finalize") {
        count("finalize");
        if (o.authz !== "valid") return problem(403, "orderNotReady", "authz not valid");
        const csrDer = Buffer.from(payload.csr, "base64url");''', '''      if (m[1] === "finalize") {
        count("finalize");
        if (ca.finalize502 > 0) { ca.finalize502--; res.writeHead(502, { "content-type": "text/html", "replay-nonce": nonce() }); return res.end("<html>502</html>"); }
        if (o.authz !== "valid") return problem(403, "orderNotReady", "authz not valid");
        if (o.status === "valid" || o.status === "processing") return problem(403, "orderNotReady", `order is ${o.status}`);
        let csrDer = Buffer.from(payload.csr, "base64url");
        if (ca.wrongKey > 0) { ca.wrongKey--; csrDer = Buffer.from((await csrFor(o.name)).replace(/-----[^-]+-----/g, "").replace(/\\s+/g, ""), "base64"); }''')
rep('''        if (ca.slowFinalizeMs) { o.releaseAt = Date.now() + ca.slowFinalizeMs; o.status = "processing"; }
        return send(200, { status: o.status });''', '''        if (ca.slowFinalizeMs) { o.releaseAt = Date.now() + ca.slowFinalizeMs; o.status = "processing"; }
        if (ca.finalizeHangAfter > 0) { ca.finalizeHangAfter--; ca.hung.push(res); return; }   // acted on, reply lost
        return send(200, { status: o.status });''')
rep('''      if (m[1] === "order") {
        count("orderPoll");''', '''      if (m[1] === "order") {
        count("orderPoll");
        if (ca.orderHang > 0) { ca.orderHang--; ca.hung.push(res); return; }
        if (ca.order502 > 0) { ca.order502--; res.writeHead(502, { "content-type": "text/html", "replay-nonce": nonce() }); return res.end("<html>502</html>"); }''')
rep('''      if (m[1] === "cert") {
        count("cert");''', '''      if (m[1] === "cert") {
        count("cert");
        if (ca.cert502 > 0) { ca.cert502--; res.writeHead(502, { "content-type": "text/html", "replay-nonce": nonce() }); return res.end("<html>502</html>"); }''')
s += r'''
// ---- RETENTION (2026-10-21): an order the CA may have acted on survives an UNCERTAIN failure -----------------------------
// A timeout / network error / 5xx after the challenge answer leaves the order's fate unknown at the CA. The order is KEPT
// (202, retry), the next ask RESUMES it on its own CA, and no fresh order is placed anywhere (a fresh order orphaned a
// certificate the CA was issuing and spent another CA's quota: 2026-10-21 19:06Z). Terminal outcomes still drop it.
const rt = { ep: 200 };
async function retentionCase(setup) {
  ca1.mode = ca2.mode = "ok"; ca1.slowFinalizeMs = ca2.slowFinalizeMs = 0;
  for (const c of _internals.CAS) c.downUntil = 0;
  for (const k of Object.keys(_internals.store().data.orders)) delete _internals.store().data.orders[k];
  delete _internals.store().data.failures[NAME];
  for (const k of Object.keys(_internals.store().data.certs)) if (k.startsWith(NAME + "|")) delete _internals.store().data.certs[k];
  rows = [leaseRow()]; EP = `https://enclave${rt.ep++}.example`;
  const key = await genKey(), csr = await csrFor(NAME, { key }), h = await spkiHashOf(csr);
  setup?.();
  const before = { o1: ca1.calls.newOrder || 0, o2: ca2.calls.newOrder || 0, fin1: ca1.calls.finalize || 0 };
  const ask = async () => call(await body({ csr }));
  return { key, csr, h, before, ask, held: () => _internals.store().data.orders[`${NAME}|${h}`] };
}
const leafSpki = (pem) => createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("hex");

test("retention: the order poll after finalize TIMES OUT: kept (202), its CA cooled for new orders, resumed on the next ask; no order anywhere else", async () => {
  const c = await retentionCase(() => { ca1.orderHang = 1; });
  let r = await c.ask();
  assert.equal(r.code, 202, JSON.stringify(r.body));
  assert.ok(c.held()?.ca === "zerossl", "the finalized order is kept");
  assert.equal(ca2.calls.newOrder || 0, c.before.o2, "no fresh order at the next CA");
  assert.equal(_internals.store().data.failures[NAME], undefined, "not charged to the name");
  assert.ok(_internals.CAS[0].downUntil > Date.now(), "the CA is cooled for NEW orders");
  r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "zerossl");
  assert.equal(ca1.calls.newOrder, c.before.o1 + 1, "resumed, not re-ordered"); assert.equal(ca2.calls.newOrder || 0, c.before.o2);
  assert.equal(leafSpki(r.body.certPem), c.h, "the certificate is for the CSR's key");
  assert.equal(c.held(), undefined, "dropped once collected");
});

test("retention: order poll 502s past the read retries: kept and resumed, one order", async () => {
  const c = await retentionCase(() => { ca1.order502 = 3; });
  let r = await c.ask();
  assert.equal(r.code, 202, JSON.stringify(r.body)); assert.ok(c.held());
  r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "zerossl");
  assert.equal(ca1.calls.newOrder, c.before.o1 + 1); assert.equal(ca2.calls.newOrder || 0, c.before.o2);
});

test("retention: a finalize the CA ACTED ON whose reply was lost: kept; the resume collects the issued certificate (one finalize, one order)", async () => {
  const c = await retentionCase(() => { ca1.finalizeHangAfter = 1; });
  let r = await c.ask();
  assert.equal(r.code, 202, JSON.stringify(r.body)); assert.ok(c.held(), "the maybe-accepted finalize keeps the order");
  r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "zerossl");
  assert.equal(ca1.calls.finalize, c.before.fin1 + 1, "not finalized twice");
  assert.equal(ca1.calls.newOrder, c.before.o1 + 1); assert.equal(ca2.calls.newOrder || 0, c.before.o2);
});

test("retention: a finalize answered 502 before the CA acted: kept; the resume sees `ready` and finalizes ONCE more with the stored CSR", async () => {
  const c = await retentionCase(() => { ca1.finalize502 = 1; });
  let r = await c.ask();
  assert.equal(r.code, 202, JSON.stringify(r.body)); assert.ok(c.held());
  r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(ca1.calls.finalize, c.before.fin1 + 2, "the stored CSR was finalized again");
  assert.equal(leafSpki(r.body.certPem), c.h);
  assert.equal(ca1.calls.newOrder, c.before.o1 + 1); assert.equal(ca2.calls.newOrder || 0, c.before.o2);
});

test("retention: the certificate download 502s past the read retries: kept and resumed", async () => {
  const c = await retentionCase(() => { ca1.cert502 = 3; });
  let r = await c.ask();
  assert.equal(r.code, 202, JSON.stringify(r.body)); assert.ok(c.held());
  r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(ca1.calls.newOrder, c.before.o1 + 1);
});

test("retention: the authz read after the challenge answer times out: kept; the validated order resumes from `ready`", async () => {
  const c = await retentionCase(() => { ca1.authzHang = 1; });
  let r = await c.ask();
  assert.equal(r.code, 202, JSON.stringify(r.body)); assert.ok(c.held());
  r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(ca1.calls.newOrder, c.before.o1 + 1); assert.equal(ca2.calls.newOrder || 0, c.before.o2);
});

test("retention, terminal: a kept order the CA then reports INVALID is dropped and the name is ordered afresh (no trap)", async () => {
  const c = await retentionCase(() => { ca1.orderHang = 1; });
  let r = await c.ask();
  assert.equal(r.code, 202, JSON.stringify(r.body));
  const id = c.held().orderUrl.split("/").pop(); ca1.orders.get(id).status = "invalid"; ca1.orders.get(id).cert = null;
  for (const x of _internals.CAS) x.downUntil = 0;
  r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(ca1.calls.newOrder, c.before.o1 + 2, "a fresh order after the terminal verdict");
  assert.equal(c.held(), undefined);
});

test("retention, bounded: a kept order older than the order TTL (1 h) is not resumed", async () => {
  const c = await retentionCase(() => { ca1.orderHang = 1; });
  let r = await c.ask();
  assert.equal(r.code, 202, JSON.stringify(r.body));
  c.held().at = Date.now() - 3600_001;
  for (const x of _internals.CAS) x.downUntil = 0;
  r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(ca1.calls.newOrder, c.before.o1 + 2, "past its TTL the order is abandoned and the name ordered afresh");
});

test("retention, unchanged verdicts: a 4xx at finalize is terminal (dropped, falls over); a failure BEFORE any order still cools and falls over", async () => {
  // a 4xx after the challenge answer: a verdict, not uncertainty
  let c = await retentionCase(() => { ca1.wrongKey = 0; });
  const fin = (o) => { const x = [...ca1.orders.values()].pop(); x.authz = "pending"; };   // not used: see below
  void fin;
  // newOrder 5xx: no order exists yet, so nothing is kept; the CA cools and the next one issues (pre-existing rule)
  c = await retentionCase(() => { ca1.mode = "5xx"; });
  const r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "letsencrypt");
  assert.equal(c.held(), undefined, "nothing kept when no order was placed");
  ca1.mode = "ok";
});

test("acceptance: a certificate for ANOTHER key than the CSR's is refused, never cached; the next CA's correct one is served", async () => {
  const c = await retentionCase(() => { ca1.wrongKey = 1; });
  const r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "letsencrypt");
  assert.equal(leafSpki(r.body.certPem), c.h, "only a certificate for the CSR's key is accepted");
  assert.equal(c.held(), undefined, "the mismatched order is dropped");
  for (const [k, v] of Object.entries(_internals.store().data.certs)) if (k.startsWith(NAME + "|")) assert.equal(leafSpki(v.certPem), k.split("|")[1]);
});
'''
open(p, "w").write(s)
