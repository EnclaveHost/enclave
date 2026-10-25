#!/usr/bin/env python3
"""verify_inputs.py <Cargo.lock> <cargo-home> <out.json>: the EXACT input manifest of the member's dependency closure.
Closure = transitive walk of the lock graph from the member's direct deps (an over-approximation: the lock is feature-
union across the workspace). Every registry package must have its .crate in <cargo-home>/registry/cache/index.crates.io-*
with sha256 == the lock checksum; every git package must come from base/reth tag base-v2.5.2.8 #7134be3b (or another
source already in the lock) and its checkout dir must exist. No path packages except the member. Exit 1 on any miss."""
import glob, hashlib, json, os, sys, tomllib
lockp, ch, outp = sys.argv[1:4]
pk = tomllib.load(open(lockp, 'rb'))['package']
by = {}
for x in pk: by.setdefault(x['name'], []).append(x)
def resolve(dep):
    f = dep.split(' ')
    c = by.get(f[0], [])
    if len(f) > 1: c = [x for x in c if x['version'] == f[1]]
    if len(f) > 2: c = [x for x in c if f'({x.get("source")})' == f[2]]
    if len(c) != 1: sys.exit(f'unresolvable lock dep {dep!r}')
    return c[0]
root = next((x for x in pk if x['name'] == 'base-bytecode-check'), None)
start = root['dependencies'] if root else ['alloy-primitives', 'reth-db', 'reth-db-api', 'reth-primitives-traits', 'revm-bytecode', 'serde_json']
seen, todo = {}, [resolve(d) for d in start]
while todo:
    x = todo.pop(); k = (x['name'], x['version'], x.get('source'))
    if k in seen: continue
    seen[k] = x; todo += [resolve(d) for d in x.get('dependencies', [])]
cache = glob.glob(os.path.join(ch, 'registry/cache/index.crates.io-*'))
if len(cache) != 1: sys.exit(f'registry cache dirs: {cache}')
bad, items = [], []
for (n, v, s), x in sorted(seen.items(), key=lambda t: (t[0][0], t[0][1])):
    it = {'name': n, 'version': v, 'source': s}
    if s is None: bad.append(f'path package in closure: {n}')
    elif s.startswith('registry+'):
        f = os.path.join(cache[0], f'{n}-{v}.crate')
        h = hashlib.sha256(open(f, 'rb').read()).hexdigest() if os.path.exists(f) else None
        it.update(checksum=x.get('checksum'), crateSha256=h)
        if h != x.get('checksum'): bad.append(f'{n} {v}: .crate {"missing" if h is None else "sha differs"}')
    elif s.startswith('git+'):
        rev = s.split('#')[1]; it['rev'] = rev
        if not glob.glob(os.path.join(ch, 'git/checkouts/*', rev[:7])): bad.append(f'{n}: no checkout for {rev[:7]}')
    else: bad.append(f'{n}: unknown source {s}')
    items.append(it)
gits = sorted({i['source'] for i in items if (i['source'] or '').startswith('git+')})
res = {'lockSha256': hashlib.sha256(open(lockp, 'rb').read()).hexdigest(), 'closurePackages': len(items),
       'registry': sum(1 for i in items if (i['source'] or '').startswith('registry+')), 'git': sum(1 for i in items if (i['source'] or '').startswith('git+')),
       'gitSources': gits, 'problems': bad, 'packages': items}
json.dump(res, open(outp, 'w'), indent=1)
print(json.dumps({k: res[k] for k in ('lockSha256', 'closurePackages', 'registry', 'git', 'gitSources')}), f'problems={len(bad)}')
for b in bad[:20]: print('PROBLEM', b)
sys.exit(1 if bad else 0)
