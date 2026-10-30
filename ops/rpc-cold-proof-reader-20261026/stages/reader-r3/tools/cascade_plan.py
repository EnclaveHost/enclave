#!/usr/bin/env python3
"""cascade_plan.py COMPOSED_STAGE (READ-ONLY; prints, writes nothing). The exact pin cascade for integrating this stage's two readers
into a composition derived from COMPOSED_STAGE (default base-finality-proof-stage/r12-final): starting from the replaced origin shas
(a1-read.mjs a501a3ec..., a1-recheck-read.mjs 41b83975...), every non-log/non-bundle file of the stage that NAMES a sha in the set must be
re-pinned, which changes its own sha, which is added to the set, until a fixed point. Output = the ordered list of files to edit, with
the lines that name each sha, plus the new reader shas. 50cf composes; root re-verifies with the composition's own job."""
import hashlib, pathlib, sys
S = pathlib.Path(__file__).resolve().parent.parent
W = next(q for q in S.parents if (q / 'base-finality-proof-stage').is_dir())
F = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else W / 'base-finality-proof-stage/r12-final'
assert F.is_dir(), F
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
OLD = {'a501a3ec56ebd56e6bf1fc43c0c3725da57d013addac5f1efb13a99e598e0ab8': 'a1-read.mjs (both copies) -> ' + sha(S / 'src/l1-anchor-a1/a1-read.mjs'),
       '41b83975e96fc816bd5743e56626dd309aa7f0ee03c6efb9912788eb184a7715': 'a1-recheck-read.mjs -> ' + sha(S / 'src/a1-original-game-prepared/a1-recheck-read.mjs')}
files = [p for p in sorted(F.rglob('*')) if p.is_file() and not ({'logs', 'bundle', '__pycache__'} & set(p.relative_to(F).parts))]
text = {}
for p in files:
    try: text[p] = p.read_text()
    except (UnicodeDecodeError, OSError): pass
want, order, seen = dict(OLD), [], set()
while True:
    new = []
    for p, t in text.items():
        if p in seen: continue
        hits = [h for h in want if h in t or h[:16] in t]
        if hits:
            new.append((p, hits))
    if not new: break
    for p, hits in new:
        seen.add(p); order.append((p, hits)); want[sha(p)] = f'{p.relative_to(F)} (re-pinned)'
for i, (p, hits) in enumerate(order, 1):
    print(f'{i:2d}. {p.relative_to(F)}  [current sha {sha(p)[:16]}]')
    for h in hits:
        lines = [n for n, l in enumerate(text[p].splitlines(), 1) if h in l or h[:16] in l]
        print(f'      names {h[:16]}... ({want[h][:90]}) at lines {lines[:12]}{" ..." if len(lines) > 12 else ""}')
print(f'\n{len(order)} files to re-pin in a composition derived from {F.name}; new reader shas:')
for h, v in OLD.items(): print(f'  {h[:16]}... {v}')
