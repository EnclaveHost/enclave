#!/usr/bin/env python3
"""READ-ONLY Solidity import closure (rig-artifact-closure-stage). usage: sol-closure.py TREE SOURCE...  -> sha256sum-format lines
(sha256  relpath) for every source and every file it transitively imports. Resolution exactly as this repo's foundry.toml gives
forge: relative imports against the importing file; `forge-std/` -> contracts/foundry/lib/forge-std/src/ (libs = contracts/foundry/lib,
auto-remapping); bare `contracts/...` paths against the root. Any import that resolves to no tracked file is printed as UNRESOLVED
(the caller fails closed)."""
import hashlib, os, re, subprocess, sys
T = sys.argv[1]; tracked = set(subprocess.run(['git', '-C', T, 'ls-files'], capture_output=True, text=True, check=True).stdout.splitlines())
IMP = re.compile(r'''^\s*import\s+(?:[^;]*?\bfrom\s+)?["']([^"']+)["']''', re.M)
def resolve(frm, p):
    if p.startswith('forge-std/'): c = 'contracts/foundry/lib/forge-std/src/' + p[len('forge-std/'):]
    elif p.startswith('.'): c = os.path.normpath(os.path.join(os.path.dirname(frm), p))
    else: c = os.path.normpath(p)
    return c if c in tracked else None
seen, todo, bad = set(), list(sys.argv[2:]), []
while todo:
    f = todo.pop()
    if f in seen: continue
    if f not in tracked: bad.append(f); continue
    seen.add(f); src = open(os.path.join(T, f), encoding='utf-8').read()
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S); src = re.sub(r'//[^\n]*', '', src)
    for m in IMP.finditer(src):
        r = resolve(f, m.group(1))
        if r is None: bad.append(f'{f} -> {m.group(1)}')
        else: todo.append(r)
for f in sorted(seen):
    print(hashlib.sha256(open(os.path.join(T, f), 'rb').read()).hexdigest() + '  ' + f)
for b in bad: print('UNRESOLVED ' + b)
