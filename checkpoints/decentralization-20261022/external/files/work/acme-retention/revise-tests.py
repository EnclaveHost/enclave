import sys
p = sys.argv[1]; s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, (s.count(a), a[:80]); s = s.replace(a, b)
# HTML 400 (not 404) for the non-JSON 4xx fixture
s = s.replace("finalizeHtml404", "finalizeHtml400")
rep('''res.writeHead(404, { "content-type": "text/html", "replay-nonce": nonce() }); return res.end("<html>404</html>"); }''',
    '''res.writeHead(400, { "content-type": "text/html", "replay-nonce": nonce() }); return res.end("<html>400</html>"); }''')
rep('''"retention, unchanged verdict: a NON-JSON 4xx at finalize (an edge page)''', '''"retention, unchanged verdict: a NON-JSON 400 at finalize (an edge page)''')
# wrongName knob: a certificate for the requester's KEY but another NAME
rep('''finalize400: 0, chalNoop: 0, finalizeHtml400: 0,''', '''finalize400: 0, chalNoop: 0, finalizeHtml400: 0, wrongName: 0,''')
rep('''        try { o.cert = await signLeaf(csrDer); o.status = "valid"; }''', '''        try { o.cert = ca.wrongName > 0 ? (ca.wrongName--, await signLeafOtherName(csrDer)) : await signLeaf(csrDer); o.status = "valid"; }''')
rep('''// ---- mock DNS_API:''', '''// the requester's KEY on a certificate for ANOTHER name (a CA fault the relay must refuse): -force_pubkey
async function signLeafOtherName(csrDer) {
  const csr = path.join(DIR, `w${++_n}.csr`), pub = path.join(DIR, `w${_n}.pub`), leaf = path.join(DIR, `w${_n}.pem`), other = path.join(DIR, `w${_n}o.pem`);
  fs.writeFileSync(csr, csrDer);
  fs.writeFileSync(pub, (await pexec("openssl", ["req", "-in", csr, "-inform", "DER", "-pubkey", "-noout"])).stdout);
  fs.writeFileSync(other, await csrFor("ffffffff.app.enclave.host"));
  await pexec("openssl", ["x509", "-req", "-in", other, "-CA", CA_PEM, "-CAkey", CA_KEY, "-force_pubkey", pub,
                          "-set_serial", "0x" + randomBytes(16).toString("hex"), "-days", "90", "-copy_extensions", "copy", "-out", leaf]);
  return fs.readFileSync(leaf, "utf8") + fs.readFileSync(CA_PEM, "utf8");
}

// ---- mock DNS_API:''')
# test 42 inverted (F4a): an authz-read timeout BEFORE the persist is unchanged: not kept, the CA cooled, falls over
i = s.index('test("retention: the authz read after the challenge answer times out'); j = s.index('test("retention, terminal: a kept order the CA then reports INVALID')
s = s[:i] + '''test("retention scope: an authz read timeout BEFORE the finalize is unchanged: NOT kept, the CA cooled, falls over (persist is at finalize)", async () => {
  const c = await retentionCase(() => { ca1.authzHang = 1; });
  const r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "letsencrypt");
  assert.equal(c.held(), undefined, "an order whose authz was never seen valid is not persisted");
  assert.ok(_internals.CAS[0].downUntil > Date.now(), "the CA is cooled as before");
  assert.equal(ca1.calls.finalize, c.before.fin1, "nothing was finalized at the first CA");
});

''' + s[j:]
s += r'''
test("acceptance: a certificate for the CSR's KEY but ANOTHER NAME is refused, never cached", async () => {
  const c = await retentionCase(() => { ca1.wrongName = 1; });
  const r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "letsencrypt");
  assert.ok(new X509Certificate(r.body.certPem).checkHost(NAME), "only a certificate for the requested name is accepted");
  assert.equal(c.held(), undefined);
});

test("retention: an order kept after a finalize-side timeout survives a relay restart and is resumed (no fresh order)", async () => {
  const c = await retentionCase(() => { ca1.orderHang = 1; });
  let r = await c.ask();
  assert.equal(r.code, 202, JSON.stringify(r.body)); assert.ok(c.held());
  _internals.CAS[0].account = null; _internals.CAS[0].dir = null; _internals.CAS[0].downUntil = 0;   // "restart": slot state gone, store kept
  r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "zerossl");
  assert.equal(ca1.calls.newOrder, c.before.o1 + 1, "resumed, not re-ordered"); assert.equal(ca2.calls.newOrder || 0, c.before.o2);
});
'''
open(p, "w").write(s)
