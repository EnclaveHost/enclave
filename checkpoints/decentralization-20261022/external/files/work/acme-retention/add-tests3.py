import sys
p = sys.argv[1]; s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, (s.count(a), a[:80]); s = s.replace(a, b)
rep('''finalize400: 0, chalNoop: 0,''', '''finalize400: 0, chalNoop: 0, finalizeHtml404: 0,''')
rep('''        if (ca.finalize400 > 0) {''', '''        if (ca.finalizeHtml404 > 0) { ca.finalizeHtml404--; res.writeHead(404, { "content-type": "text/html", "replay-nonce": nonce() }); return res.end("<html>404</html>"); }
        if (ca.finalize400 > 0) {''')
s += r'''
test("retention, unchanged verdict: a NON-JSON 4xx at finalize (an edge page) is a verdict, not uncertainty: dropped, cooled, falls over", async () => {
  const c = await retentionCase(() => { ca1.finalizeHtml404 = 1; });
  const r = await c.ask();
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ca, "letsencrypt");
  assert.equal(c.held(), undefined, "a 4xx does not keep the order");
});
'''
open(p, "w").write(s)
