import sys
p = sys.argv[1]; s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, (s.count(a), a[:80]); s = s.replace(a, b)
rep('''orderHang: 0, order502: 0, finalizeHangAfter: 0, finalize502: 0,''', '''orderHang: 0, order502: 0, finalizeHangAfter: 0, finalize502: 0, finalize400: 0,''')
rep('''        if (ca.finalize502 > 0) {''', '''        if (ca.finalize400 > 0) { ca.finalize400--; return problem(400, "badCSR", "refused"); }
        if (ca.finalize502 > 0) {''')
i = s.index('test("retention, unchanged verdicts:'); j = s.index('test("acceptance: a certificate for ANOTHER key')
s = s[:i] + '''test("retention, unchanged verdicts: a 4xx at finalize is terminal (dropped, falls over); a failure BEFORE any order still cools and falls over", async () => {
  // a 4xx after the challenge answer is the CA's verdict, not uncertainty: dropped, and the walk moves on
  let c = await retentionCase(() => { ca1.finalize400 = 1; });
  let r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "letsencrypt");
  assert.equal(c.held(), undefined, "a refused finalize does not keep the order");
  assert.equal(_internals.CAS[0].downUntil, 0, "a name-level refusal does not cool the CA");
  // newOrder 5xx: no order exists yet, so nothing is kept; the CA cools and the next one issues (pre-existing rule)
  c = await retentionCase(() => { ca1.mode = "5xx"; });
  r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "letsencrypt");
  assert.equal(c.held(), undefined, "nothing kept when no order was placed");
  assert.ok(_internals.CAS[0].downUntil > Date.now(), "the failing CA is cooled");
  ca1.mode = "ok";
});

''' + s[j:]
open(p, "w").write(s)
