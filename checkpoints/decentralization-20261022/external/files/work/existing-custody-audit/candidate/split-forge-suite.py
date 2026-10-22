#!/usr/bin/env python3
"""Split one Foundry test contract into N files that keep EVERY non-test member (helpers, state, setUp, helper contracts)
byte-identical and distribute the test* functions round-robin-by-order into parts. Used only because a via_ir compile of
the whole suite exceeds the 768 MiB job cap. Prints a manifest (part -> test names) to verify full coverage."""
import sys, re, json
src, contract, nparts, outpat = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
s = open(src).read()
start = s.index("contract " + contract + " ")
body_open = s.index("{", start)
def match(i):  # index of the brace closing the one at i, skipping strings and comments
    depth, j, n = 0, i, len(s)
    while j < n:
        c = s[j]
        if s.startswith("//", j): j = s.index("\n", j); continue
        if s.startswith("/*", j): j = s.index("*/", j) + 2; continue
        if c == '"':
            j += 1
            while s[j] != '"': j += 2 if s[j] == "\\" else 1
        elif c == "{": depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0: return j
        j += 1
    raise SystemExit("unbalanced")
end = match(body_open)
tests = []
for m in re.finditer(r"\n    function (test\w*)\s*\(", s[body_open:end]):
    a = body_open + m.start() + 1
    b = match(s.index("{", a)) + 1
    if s[b:b+1] == "\n": b += 1
    tests.append((m.group(1), a, b))
chunk = -(-len(tests) // nparts)
manifest = {}
for k in range(nparts):
    keep = set(range(k * chunk, min(len(tests), (k + 1) * chunk)))
    out, pos = [], 0
    for i, (name, a, b) in enumerate(tests):
        out.append(s[pos:a]); pos = b
        if i in keep: out.append(s[a:b])
    out.append(s[pos:])
    open(outpat % (k + 1), "w").write("".join(out))
    manifest[k + 1] = [tests[i][0] for i in sorted(keep)]
print(json.dumps({"tests": len(tests), "parts": manifest}))
