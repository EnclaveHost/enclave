#!/usr/bin/env python3
"""copy-artifacts.py SRC_FOUNDRY DST_FOUNDRY MANIFEST  (r12; replaces r11 jobs/r11-build-validate.sh line 123)

Copy EXACTLY the reviewed contract artifacts of one pinned offline forge build (MANIFEST = that build's ARTIFACTS-<tree>.sha256,
lines "<sha256>  out/<Source>.sol/<Name>.json", LC_ALL=C sorted, build-info excluded) into a fresh tree's contracts/foundry.

r11's line 123 ran `find out -mindepth 1 -maxdepth 1 -not -name build-info -exec cp -a {} $T/contracts/foundry/out/ \\;` with no
out/ yet: the FIRST entry (out/PaymentRouter.sol) was copied AS out/ (its three artifacts flattened to out/ root), find -exec \\;
does not propagate cp's status and 2>/dev/null hid the errors, so the mkdir fallback never ran (root-composition-r11-pre-0305:
"verifier: copied artifacts differ"; only the final manifest compare caught it). Here:
  - the destination out/ must NOT exist (never merged into) and is created BEFORE any copy;
  - only manifest paths are copied (strict path grammar, no '..', never build-info); the source must hold exactly those files;
  - each source is a regular file whose bytes equal its manifest sha256; each destination is created O_EXCL|O_NOFOLLOW and its
    bytes re-read and re-hashed; afterwards the destination holds exactly the manifest set;
  - any deviation: one line "REFUSED: ..." and exit 1 (exit 2: usage). Nothing is suppressed.
The caller still recomputes the destination manifest and compares it (r11 line 124, unchanged) - an independent second check.
"""
import hashlib, os, pathlib, re, stat, sys

REL = re.compile(r'out/[A-Za-z0-9_.+-]+(/[A-Za-z0-9_.+-]+)*\.json')
CAP = 64 << 20                                         # largest contract artifact is far below; refuse anything larger


def refuse(m):
    print(f'REFUSED: {m}'); sys.exit(1)


def read(p):
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            refuse(f'{p} is not a regular file')
        b, chunks, n = b'', [], 0
        while (c := os.read(fd, 1 << 20)):
            chunks.append(c); n += len(c)
            if n > CAP:
                refuse(f'{p} exceeds {CAP} bytes')
        return b.join(chunks)
    finally:
        os.close(fd)


def files_under(out, root):
    got = []
    for d, ds, fs in os.walk(out):
        for x in ds + fs:
            p = os.path.join(d, x)
            if os.path.islink(p):
                refuse(f'{os.path.relpath(p, root)} is a symlink')
        got += [os.path.relpath(os.path.join(d, f), root) for f in fs]
    return sorted(r for r in got if not r.startswith('out/build-info/'))


def main(argv):
    if len(argv) != 4:
        print(__doc__); return 2
    src, dst, man = pathlib.Path(argv[1]), pathlib.Path(argv[2]), pathlib.Path(argv[3])
    rows = [l.split('  ', 1) for l in read(man).decode().splitlines()]
    if not rows or any(len(r) != 2 or not re.fullmatch(r'[0-9a-f]{64}', r[0]) for r in rows):
        refuse('manifest is empty or not "<sha256>  <path>" lines')
    rels = [r[1] for r in rows]
    if rels != sorted(rels, key=str.encode) or len(set(rels)) != len(rels):
        refuse('manifest paths are not unique and LC_ALL=C sorted')
    for rel in rels:
        if not REL.fullmatch(rel) or '..' in rel.split('/') or rel.startswith('out/build-info/'):
            refuse(f'not a reviewed artifact path: {rel!r}')
    if files_under(src / 'out', src) != sorted(rels):
        refuse('the source build holds other files than its manifest (outside build-info)')
    st = os.lstat(dst)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        refuse(f'{dst} is not a real directory')
    out = dst / 'out'
    if os.path.lexists(out):
        refuse(f'{out} already exists: artifacts are never merged into an existing out/')
    os.mkdir(out, 0o755)                                # the destination directory exists BEFORE any copy
    for h, rel in rows:
        b = read(src / rel)
        if hashlib.sha256(b).hexdigest() != h:
            refuse(f'{rel}: source bytes differ from the manifest')
        dp = dst / rel
        dp.parent.mkdir(parents=True, exist_ok=True)     # inside out/ only (grammar above), created by us
        fd = os.open(dp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, os.lstat(src / rel).st_mode & 0o755 or 0o644)
        try:
            v = memoryview(b)
            while v:
                v = v[os.write(fd, v):]
        finally:
            os.close(fd)
        if hashlib.sha256(read(dp)).hexdigest() != h:
            refuse(f'{rel}: destination bytes differ after the copy')
    if files_under(out, dst) != sorted(rels) or os.path.lexists(out / 'build-info'):
        refuse('the destination does not hold exactly the manifest set')
    print(f'copied {len(rels)} artifacts into {out} (exact manifest set)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
