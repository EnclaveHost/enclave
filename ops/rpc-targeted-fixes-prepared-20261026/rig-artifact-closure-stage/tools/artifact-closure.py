#!/usr/bin/env python3
"""Static, READ-ONLY map of every Foundry-artifact read reachable from a set of node tests (rig-artifact-closure-stage).
Nothing is executed, compiled or written inside TREE. Usage:
  artifact-closure.py TREE LABEL TESTLIST [--patch FILE]   (TESTLIST: one repo-relative test path per line; '#' comments)
Closure: every local module reachable from a test through static/dynamic imports, re-exports, and any string literal naming an
existing .mjs/.js/.cjs file (spawned child scripts, new URL(...)). Within the closure it reports, per file:line,
  DEF   a helper whose body builds a contracts/foundry/out path (name, path template)
  CALL  a call of such a helper (by its own name, an import alias, or a property call) with LITERAL args -> the artifact path
  DYN   a call whose args are not both literals (must be resolved by hand; the run fails closed on an unresolved DYN)
  LIT   a literal contracts/foundry/out/... reference (existsSync gates, direct reads)
Output TSV on stdout: kind  label  test  file:line  artifact  detail."""
import os, re, sys, subprocess

TREE, LABEL, TESTLIST = sys.argv[1], sys.argv[2], sys.argv[3]
PATCH = sys.argv[sys.argv.index('--patch') + 1] if '--patch' in sys.argv else None
tracked = set(subprocess.run(['git', '-C', TREE, 'ls-files'], capture_output=True, text=True, check=True).stdout.splitlines())
SKIP = re.compile(r'(^|/)node_modules/|\.bundle\.mjs$|^metal/guest/|^network/host-services/packages/')

def read(rel):
    with open(os.path.join(TREE, rel), encoding='utf-8', errors='replace') as f:
        return f.read()

IMP = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}/[^"']+)\1''')
LITFILE = re.compile(r'''(["'`])([^"'`\s]+\.(?:mjs|cjs|js))\1''')
def neighbours(rel, text):
    d = os.path.dirname(rel); out = set()
    for m in IMP.finditer(text):
        out.add(os.path.normpath(os.path.join(d, m.group(2))))
    for m in LITFILE.finditer(text):
        s = m.group(2)
        for c in (os.path.normpath(os.path.join(d, s)), os.path.normpath(s.lstrip('/'))):
            if c in tracked: out.add(c)
    return {p for p in out if p in tracked and not SKIP.search(p)}

def closure(test):
    seen, todo = set(), [test]
    while todo:
        r = todo.pop()
        if r in seen or r not in tracked: continue
        seen.add(r); todo.extend(neighbours(r, read(r)) - seen)
    return seen

OUTPATH = re.compile(r'''foundry["']?\s*,\s*["']out["']|foundry/out|leaseGasForgeOut\(\)''')
DEFN = re.compile(r'''^\s*(?:export\s+)?(?:const\s+(\w+)\s*=\s*(?:async\s*)?\(([\w\s,]*)\)\s*=>|function\s+(\w+)\s*\(([\w\s,]*)\))''')
OUTVAR = re.compile(r'''(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*(?:foundry["']?\s*,\s*["']out["']|foundry/out)''')
def root_of(body):
    return 'lease-gas-forge-out(runtime build)' if 'leaseGasForgeOut()' in body else 'contracts/foundry/out'
def helpers(text, imported=None):
    """name -> (line, template, root): a function whose OWN definition line (or the line after an opening brace) reads JSON under
    a foundry out dir, directly or via an OUT variable; plus one-line WRAPPERS of an already-known helper (iterated)"""
    lines = text.split('\n'); outvars = {m.group(1) for m in OUTVAR.finditer(text)}; hs = {}
    known = dict(imported or {})
    for _ in range(3):
        for i, l in enumerate(lines):
            m = DEFN.search(l)
            if not m: continue
            name = m.group(1) or m.group(3)
            body = l if not l.rstrip().endswith('{') else l + '\n' + (lines[i + 1] if i + 1 < len(lines) else '')
            reads = re.search(r'readFileSync|readFile\(', body)
            outref = OUTPATH.search(body) or any(re.search(r'\b%s\b' % re.escape(v), body) for v in outvars)
            if reads and outref:
                hs[name] = (i + 1, '.sol-appended' if re.search(r'\$\{\w+\}\.sol', body) else 'as-given', root_of(body)); known[name] = hs[name]
                continue
            for k, v in list(known.items()):
                if k != name and re.search(r'(?<![\w$])%s\(' % re.escape(k), body):
                    hs[name] = (i + 1, v[1], v[2] + ' via ' + k); known[name] = hs[name]
    return hs

GATE = re.compile(r'''path\.join\(\s*(\w+|leaseGasForgeOut\(\))\s*,\s*["']([^"']+\.sol)["']\s*,\s*["']([^"']+\.json)["']\s*\)''')
IMPORTNAMES = re.compile(r'''import\s*\{([^}]*)\}\s*from\s*(["'])(\.{1,2}/[^"']+)\2''')
LIT_OUT = re.compile(r'''foundry/out/([A-Za-z0-9_.\-/]+\.json)''')
def scan(rel, text, defs_by_file):
    """-> rows for one file: its own helpers + imported helpers (aliases) + property calls of any known helper name"""
    rows = []; names = {n: (rel, t, rt) for n, (ln, t, rt) in defs_by_file.get(rel, {}).items()}
    for m in IMPORTNAMES.finditer(text):
        src = os.path.normpath(os.path.join(os.path.dirname(rel), m.group(3)))
        for spec in m.group(1).split(','):
            parts = spec.strip().split(' as ')
            if parts[0].strip() in defs_by_file.get(src, {}):
                names[(parts[1] if len(parts) > 1 else parts[0]).strip()] = (src, defs_by_file[src][parts[0].strip()][1], defs_by_file[src][parts[0].strip()][2])
    allnames = {n for d in defs_by_file.values() for n in d}
    for i, l in enumerate(text.split('\n'), 1):
        for n in set(names) | allnames:
            for m in re.finditer(r'(?<![\w$])(?:(\w+)\.)?%s\(' % re.escape(n), l):
                if m.group(1) is None and n not in names: continue          # a bare name that is not this file's helper
                if re.match(r'\s*(?:const|let|var|function)\b', l) and re.search(r'(?:const|let|var|function)\s+%s\b' % re.escape(n), l): continue
                args = l[m.end():]
                a = re.match(r'''\s*(["'`])([^"'`$]+)\1\s*,\s*(["'`])([^"'`$]+)\3\s*\)''', args)
                tmpl, root = names.get(n, (None, None, '?'))[1:]
                if a:
                    f, c = a.group(2), a.group(4)
                    if tmpl == '.sol-appended' and not f.endswith('.sol'): f += '.sol'
                    rows.append(('CALL', f'{rel}:{i}', f'{f}/{c}.json', f'{n}() root={root}{" def " + names[n][0] if n in names and names[n][0] != rel else ""}'))
                else:
                    rows.append(('DYN', f'{rel}:{i}', '?', f'{n}({args[:90].strip()}'))
        for m in GATE.finditer(l):
            if m.group(1) in ('OUT', 'leaseGasForgeOut()') or m.group(1).lower().endswith('out'):
                rows.append(('GATE', f'{rel}:{i}', f'{m.group(2)}/{m.group(3)}', ('root=lease-gas-forge-out(runtime build) ' if 'lease' in m.group(1) else 'root=contracts/foundry/out ') + l.strip()[:70]))
        for m in LIT_OUT.finditer(l):
            rows.append(('LIT', f'{rel}:{i}', m.group(1), l.strip()[:90]))
    return rows

tests = [t.split()[0] for t in open(TESTLIST) if t.strip() and not t.startswith('#')]
for t in tests:
    if t not in tracked:
        print(f'MISSING\t{LABEL}\t{t}\t-\t-\ttest file not tracked in this tree'); continue
    cl = sorted(closure(t)); texts = {r: read(r) for r in cl}
    defs = {}
    for _ in range(3):                                      # imported helpers propagate into importer wrappers (fixpoint)
        for r, x in texts.items():
            imp = {}
            for m in IMPORTNAMES.finditer(x):
                src = os.path.normpath(os.path.join(os.path.dirname(r), m.group(3)))
                for spec in m.group(1).split(','):
                    pa = [q.strip() for q in spec.split(' as ')]
                    if pa[0] in defs.get(src, {}): imp[pa[-1]] = defs[src][pa[0]]
            defs[r] = helpers(x, imp)
    for r, hs in defs.items():
        for n, (ln, tmpl, root) in hs.items():
            print(f'DEF\t{LABEL}\t{t}\t{r}:{ln}\t-\t{n} {tmpl} root={root}')
    for r in cl:
        for k, loc, a, d in scan(r, texts[r], defs):
            print(f'{k}\t{LABEL}\t{t}\t{loc}\t{a}\t{d}')
    print(f'CLOSURE\t{LABEL}\t{t}\t{len(cl)} files\t-\t-')
if PATCH:
    for i, l in enumerate(open(PATCH, encoding='utf-8'), 1):
        if l.startswith('+') and not l.startswith('+++') and (re.search(r'(?<![\w$])(?:\w+\.)?(?:art|leaseArt|artifact)\(', l) or LIT_OUT.search(l)):
            print(f'PATCH\t{LABEL}\t-\t{os.path.basename(PATCH)}:{i}\t-\t{l[1:].strip()[:110]}')
