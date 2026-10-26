#!/usr/bin/env python3
"""assemble_bundle.py (workstation; PREPARED, NOT run): copy EXACTLY the closure's reviewed inputs into <stage>/bundle/, each from the
origin recorded in bundle-origin.json, verifying every byte against install/MANIFEST.json (files and every tree file). Refuses an
existing bundle, a mismatching or missing input, a symlink, or any file outside the manifest. Nothing is fetched or built."""
import hashlib, json, os, pathlib, shutil, stat, sys
ST = pathlib.Path(__file__).resolve().parents[1]; B = ST / 'bundle'
sha = lambda b: hashlib.sha256(b).hexdigest()
def put(src, dst, want, mode):
    st = os.lstat(src)
    if not stat.S_ISREG(st.st_mode):
        raise SystemExit(f'{src} is not a regular file')
    b = pathlib.Path(src).read_bytes()
    if sha(b) != want:
        raise SystemExit(f'{src} is not the pinned {want[:12]}')
    dst.parent.mkdir(parents=True, exist_ok=True); dst.write_bytes(b); os.chmod(dst, mode)
def main():
    if os.path.lexists(B):
        raise SystemExit(f'{B} exists: refusing to mix bundles')
    m = json.loads((ST / 'install/MANIFEST.json').read_text()); origin = json.loads((ST / 'bundle-origin.json').read_text())
    for e in m['files']:
        put(origin[e['src']], B / e['src'], e['sha256'], int(e['mode'], 8))
    for t in m['trees']:
        for r, h in t['files'].items():
            put(pathlib.Path(origin[t['src']], r), B / t['src'] / r, h, 0o644)
    n = sum(1 for p in B.rglob('*') if p.is_file())
    print(json.dumps({'bundle': str(B), 'files': n, 'expected': len(m['files']) + sum(len(t['files']) for t in m['trees'])}))
    return 0 if n == len(m['files']) + sum(len(t['files']) for t in m['trees']) else 1
if __name__ == '__main__':
    sys.exit(main())
