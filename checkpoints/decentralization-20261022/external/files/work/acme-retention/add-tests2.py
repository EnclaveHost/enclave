import sys
p = sys.argv[1]; s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, (s.count(a), a[:80]); s = s.replace(a, b)
rep('''finalize400: 0,''', '''finalize400: 0, chalNoop: 0,''')
rep('''        count("challenge");''', '''        count("challenge");
        if (ca.chalNoop > 0) { ca.chalNoop--; return send(200, authzBody().challenges[0]); }   // never validates: authz stays pending''')
s += r'''
test("retention: a RESUME that hits another timeout keeps the order again; the next one collects it (still one order)", async () => {
  const c = await retentionCase(() => { ca1.orderHang = 2; });     // the first collect AND the first resume read hang
  let r = await c.ask();
  assert.equal(r.code, 202, JSON.stringify(r.body)); assert.ok(c.held());
  r = await c.ask();
  assert.equal(r.code, 202, JSON.stringify(r.body)); assert.ok(c.held(), "kept across an uncertain resume");
  assert.equal(ca2.calls.newOrder || 0, c.before.o2, "no fallover while the order is kept");
  r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "zerossl");
  assert.equal(ca1.calls.newOrder, c.before.o1 + 1);
});

test("retention, unchanged verdict: an authz that never validates by the poll DEADLINE still indicts the CA (dropped, cooled, falls over)", async () => {
  const c = await retentionCase(() => { ca1.chalNoop = 1; });
  const r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "letsencrypt");
  assert.equal(c.held(), undefined, "a deadline is a verdict: the order is not kept");
  assert.ok(_internals.CAS[0].downUntil > Date.now());
});
'''
open(p, "w").write(s)
