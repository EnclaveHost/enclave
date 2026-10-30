#!/usr/bin/env python3
"""assemble_canary_bundle.py OUTDIR (workstation; PREPARED, NOT run): the canary's bundle = EXACTLY the frozen
production-capture-closure-stage inputs (install/MANIFEST.json files + trees, each from bundle-origin.json, every byte checked against
the manifest; same rules as that stage's tools/assemble_bundle.py, which is NOT run because it writes into that stage) PLUS the three A1
gate files the patched module reads from <module grandparent>/a1gate/ (checked against the module's own A1_GATE_PINS). Writes
OUTDIR/bundle/ and OUTDIR/BUNDLE.sha256; never writes into another stage. Nothing fetched or built."""
import ast, hashlib, json, os, pathlib, stat, sys
W = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
CL = W / 'production-capture-closure-stage'; GATE = W / 'a1-capture-binding-stage/r4/a1gate'
sha = lambda b: hashlib.sha256(b).hexdigest()
def put(src, dst, want, mode, rows):
    st = os.lstat(src)
    if not stat.S_ISREG(st.st_mode):
        raise SystemExit(f'{src} is not a regular file')
    b = pathlib.Path(src).read_bytes()
    if sha(b) != want:
        raise SystemExit(f'{src} is not the pinned {want[:12]}')
    dst.parent.mkdir(parents=True, exist_ok=True); dst.write_bytes(b); os.chmod(dst, mode); rows.append(f'{want}  {dst}')
def main(out):
    B = pathlib.Path(out) / 'bundle'
    if os.path.lexists(B):
        raise SystemExit(f'{B} exists')
    m = json.loads((CL / 'install/MANIFEST.json').read_text()); origin = json.loads((CL / 'bundle-origin.json').read_text()); rows = []
    for e in m['files']:
        src = origin[e['src']]; src = src if os.path.isabs(src) else str(CL / src)
        put(src, B / e['src'], e['sha256'], int(e['mode'], 8), rows)
    for t in m['trees']:
        for r, h in t['files'].items():
            put(pathlib.Path(origin[t['src']], r), B / t['src'] / r, h, 0o644, rows)
    tree = ast.parse((CL / 'src/a1_capture.py').read_text())
    pins = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == 'A1_GATE_PINS')
    for name, want in sorted(pins.items()):
        put(GATE / name, B / 'a1gate' / name, want, 0o444, rows)
    rel = [r.replace(f'  {B}/', '  ') for r in rows]
    (pathlib.Path(out) / 'BUNDLE.sha256').write_text('\n'.join(sorted(rel, key=lambda x: x[66:])) + '\n')
    print(json.dumps({'bundle': str(B), 'files': len(rows), 'manifestFiles': len(m['files']), 'treeFiles': sum(len(t['files']) for t in m['trees']), 'gate': len(pins)}))
if __name__ == '__main__':
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    main(sys.argv[1])
