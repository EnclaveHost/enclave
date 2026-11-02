#!/usr/bin/env python3
"""Pin kzgcheck's Cargo.lock to the exact versions/checksums in base v1.5.1's Cargo.lock.

usage: lockcheck.py BASE_CARGO_LOCK KZGCHECK_DIR [--fix]
--fix runs `cargo update --offline -p NAME --precise VER` for each mismatch (no network).
Exit 0 only when every non-root package equals the Base lock entry.
"""
import subprocess
import sys
import tomllib
from pathlib import Path


def packages(path):
    return [(p['name'], p['version'], p.get('checksum'), p.get('source'))
            for p in tomllib.loads(Path(path).read_text())['package']]


def compatible(a, b):
    a, b = [int(x) for x in a.split('+')[0].split('-')[0].split('.')], [int(x) for x in b.split('+')[0].split('-')[0].split('.')]
    return a[0] == b[0] and (a[0] > 0 or a[1] == b[1])


def main(argv):
    base_lock, root, fix = argv[0], Path(argv[1]), '--fix' in argv
    pinned = {}
    for name, ver, ck, src in packages(base_lock):
        pinned.setdefault(name, []).append((ver, ck, src))
    for _ in range(8 if fix else 1):
        bad = []
        for name, ver, ck, src in packages(root / 'Cargo.lock'):
            if name == 'kzgcheck':
                continue
            want = [p for p in pinned.get(name, []) if p[2] == src]
            if (ver, ck, src) not in want:
                bad.append((name, ver, want))
        if not bad or not fix:
            break
        for name, ver, want in bad:
            # Several versions of one crate can coexist; only the single semver-compatible one may replace ours.
            want = [w for w in want if compatible(ver, w[0])]
            if not want:
                continue   # may disappear once its parents are pinned; the final strict pass decides
            if len(want) != 1:
                sys.exit(f'{name} {ver}: base lock has {len(want)} compatible candidates; refusing to guess')
            subprocess.run(['cargo', 'update', '--offline', '-p', f'{name}@{ver}', '--precise', want[0][0]],
                           cwd=root, check=False)   # cascades are re-verified next round
    for name, ver, want in bad:
        print(f'MISMATCH {name} {ver} base={[w[0] for w in want]}')
    if bad:
        sys.exit(1)
    print('lockcheck: every dependency equals base-v1.5.1 Cargo.lock (version+checksum+source)')


if __name__ == '__main__':
    main(sys.argv[1:])
