# site.css: the fresh output must be the committed output with exactly the two deployments.css pool-badge rules inserted
import sys, re, difflib, hashlib
old, new = open(sys.argv[1]).read(), open(sys.argv[2]).read()
split = lambda s: [t for t in re.split(r'(?<=[};])(?=[^;])', s) if t]
a, b = split(old), split(new)
ops = [(t, a[i1:i2], b[j1:j2]) for t, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if t != "equal"]
print("committed sha256", hashlib.sha256(old.encode()).hexdigest(), "fresh sha256", hashlib.sha256(new.encode()).hexdigest())
for t, x, y in ops: print(t, "removed:", x, "added:", y)
ins = "".join("".join(y) for t, x, y in ops)
want = {".enc-pool .ap-badge{vertical-align:.1em;padding:.1em .45em;font-size:.6rem}", ".enc-main .enc-pool .ap-badge:before{content:none}"}
ok = all(t == "insert" for t, x, y in ops) and set(re.findall(r'[^}]*\}', ins)) == want
print(("PASS" if ok else "FAIL"), "only insertions, exactly the two rules of deployments.css lines 99-100 (f2f0b3880)")
sys.exit(0 if ok else 1)
