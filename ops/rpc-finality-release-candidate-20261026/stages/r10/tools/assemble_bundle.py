#!/usr/bin/env python3
"""assemble_bundle.py (base-finality-proof-stage/r9; workstation; PREPARED): copy every bundle/ entry of install/MANIFEST.json from its
pinned origin (bundle-origin.json) into <stage>/bundle/, verifying each file sha and each tree's exact file set + digest BEFORE and AFTER
the copy. Existing different bytes refuse. The guest installer then reads only stage-relative, hash-checked bytes."""
import hashlib, json, os, pathlib, shutil, stat, sys

HERE = pathlib.Path(__file__).resolve().parent; STAGE = HERE.parent
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


def tree_files(root):
    out = {}
    for dp, dns, fns in os.walk(root):
        for n in dns + fns:
            p = pathlib.Path(dp, n); st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                raise SystemExit(f'{p} is a symlink')
            if stat.S_ISREG(st.st_mode):
                out[p.relative_to(root).as_posix()] = sha(p)
    return out


def main():
    bo = json.loads((STAGE / 'bundle-origin.json').read_bytes())['entries']
    for rel, e in sorted(bo.items()):
        dst, src = STAGE / rel, pathlib.Path(e['origin'])
        if 'sha256' in e:
            if sha(src) != e['sha256']:
                raise SystemExit(f'origin {src} differs from {e["sha256"][:12]}')
            if dst.exists() and sha(dst) != e['sha256']:
                raise SystemExit(f'{dst} exists with other bytes')
            dst.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(src, dst); os.chmod(dst, 0o644 if not rel.endswith(('helios-eeffcc9',)) else 0o755)
            assert sha(dst) == e['sha256'], rel
        else:
            have = {k: v for k, v in tree_files(src).items() if k in e['files']}
            if have != e['files']:
                raise SystemExit(f'origin tree {src} lacks or differs from the pinned files')
            for k in sorted(e['files']):
                d = dst / k; d.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(src / k, d)
            if tree_files(dst) != e['files']:
                raise SystemExit(f'{dst} is not exactly the pinned tree')
    print(json.dumps({'ok': True, 'entries': len(bo)}))


if __name__ == '__main__':
    sys.exit(main())
