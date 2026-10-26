#!/usr/bin/env python3
"""mdbx-recovery-validator-stage/r1 wrapper (PREPARED by Claude; NOT run by Claude). READ-ONLY structural check of a reth/Base MDBX
database with the OFFICIAL libmdbx v0.13.12 (f619d43d) `mdbx_chk` - the exact libmdbx the production Base holder (base v1.5.1,
reth 7134be3) was built with.

  mdbx_check.py --chk BIN --chk-sha256 SHA --db-dir DIR [--meta 0|1|2] [--timeout SEC] [--out REPORT.json]

Refuses unless DIR (the reth `db` directory holding mdbx.dat) is a real directory on a mount flagged READ-ONLY (statvfs ST_RDONLY):
then libmdbx's lck_setup() gets EROFS/EACCES, confirms the filesystem is read-only (osal_check_fs_rdonly) and continues in
"without-lck" mode - no lock file is created, opened for write or changed. mdbx_chk itself runs with its default
MDBX_RDONLY|MDBX_EXCLUSIVE|MDBX_VALIDATION, full B-tree page traversal and key/value traversal. The ONLY other option this wrapper
passes is -0/-1/-2 (check a specific meta page; read-only, exclusive). -w, -t, -T, -c, -d, -s, -i, -u, -U are never passed.

mdbx_chk exit codes (mdbx_chk.c): 0 OK, 1 minor problems, 2 major problems, 3 MDBX error (e.g. cannot open / corrupted meta /
MDBX_WANNA_RECOVERY), 4 system error, 5 interrupted/usage. ONLY 0 counts as a structurally clean database.

NOT chain verification: MDBX has no per-page checksums, so value bytes that keep a valid page structure are NOT checked; nothing
here decodes reth tables or checks state/trie roots (see logs/claude-mdbx-validator-1661.md for the further required checks)."""
import argparse, hashlib, json, os, stat, subprocess, sys, time

FORMAT = "mdbx-readonly-check-report/r1"
LIBMDBX_DESCRIBE = "v0.13.12-0-gf619d43d"
OUTPUT_CAP = 16 << 20
EXIT = {0: "ok", 1: "minor-problems", 2: "major-problems", 3: "mdbx-error", 4: "system-error", 5: "interrupted-or-usage"}


class Refused(Exception):
    pass


def file_sha256(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022:
            raise Refused(f"{path}: must be a regular, not group/world-writable file")
        h = hashlib.sha256()
        for b in iter(lambda: os.read(fd, 1 << 20), b""):
            h.update(b)
        return h.hexdigest()
    finally:
        os.close(fd)


def identity(db_dir):
    """cheap identity of the DB directory (never a full read): names + (ino, size, mtime_ns) of every entry"""
    out = {}
    for n in sorted(os.listdir(db_dir)):
        st = os.lstat(os.path.join(db_dir, n))
        out[n] = [stat.S_IFMT(st.st_mode), st.st_ino, st.st_size, st.st_mtime_ns]
    return out


def preflight(db_dir):
    if os.path.islink(db_dir) or not os.path.isdir(db_dir):
        raise Refused(f"{db_dir}: must be a real directory (no symlink)")
    dat = os.path.join(db_dir, "mdbx.dat")
    st = os.lstat(dat) if os.path.lexists(dat) else None
    if st is None or not stat.S_ISREG(st.st_mode):
        raise Refused(f"{db_dir}: no regular mdbx.dat")
    if not os.statvfs(db_dir).f_flag & os.ST_RDONLY:
        raise Refused(f"{db_dir} is not on a READ-ONLY mount (statvfs ST_RDONLY): refusing (no lock/meta mutation is possible only on a read-only view)")
    ver = None
    vp = os.path.join(db_dir, "database.version")                       # reth DB_VERSION file (reth 7134be3: version 2)
    if os.path.lexists(vp):
        with open(vp, "rb") as f:
            ver = f.read(64).decode("ascii", "replace").strip()
    return {"mdbxDatBytes": st.st_size, "databaseVersion": ver}


def argv_for(chk, db_dir, meta):
    argv = [chk, "-v"]
    if meta is not None:
        if meta not in (0, 1, 2):
            raise Refused("--meta must be 0, 1 or 2")
        argv.append(f"-{meta}")
    return argv + [db_dir]


def bounded_run(argv, timeout):
    p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env={"PATH": "/usr/bin:/bin"})
    out, n, t0 = [], 0, time.monotonic()
    try:
        while True:
            if time.monotonic() - t0 > timeout:
                p.kill(); p.wait(); raise Refused(f"mdbx_chk exceeded {timeout} s (killed)")
            b = p.stdout.read1(65536)
            if not b:
                break
            n += len(b)
            if n <= OUTPUT_CAP:
                out.append(b)
        p.wait(timeout=max(1, timeout - (time.monotonic() - t0)))
    finally:
        if p.poll() is None:
            p.kill(); p.wait()
    return p.returncode, b"".join(out).decode("utf-8", "replace"), n > OUTPUT_CAP


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--chk", required=True); ap.add_argument("--chk-sha256", required=True); ap.add_argument("--db-dir", required=True)
    ap.add_argument("--meta", type=int); ap.add_argument("--timeout", type=int, default=86400); ap.add_argument("--out")
    o = ap.parse_args(argv[1:])
    try:
        if file_sha256(o.chk) != o.chk_sha256:
            raise Refused("mdbx_chk is not the pinned build (sha256)")
        rc_v, vout, _ = bounded_run([o.chk, "-V"], 30)
        if LIBMDBX_DESCRIBE not in vout:
            raise Refused(f"mdbx_chk -V does not report {LIBMDBX_DESCRIBE}")
        pre = preflight(o.db_dir)
        if o.out and os.path.lexists(o.out):
            raise Refused(f"{o.out} exists: never overwritten")
        before = identity(o.db_dir)
        cmd = argv_for(o.chk, o.db_dir, o.meta)
        t0 = time.monotonic(); rc, text, cut = bounded_run(cmd, o.timeout); sec = round(time.monotonic() - t0, 1)
        after = identity(o.db_dir)
        report = {"format": FORMAT, "libmdbx": LIBMDBX_DESCRIBE, "chk": {"path": o.chk, "sha256": o.chk_sha256}, "argv": cmd, "dbDir": o.db_dir,
                  "preflight": pre, "rc": rc, "result": EXIT.get(rc, f"rc-{rc}"), "structurallyClean": rc == 0, "seconds": sec,
                  "outputTruncated": cut, "unchangedIdentity": before == after, "outputTail": text[-8192:],
                  "notChecked": ["value bytes inside structurally valid pages (MDBX has no per-page checksums)", "reth table semantics",
                                 "state/trie roots", "static_files segments", "chain authenticity"]}
        if before != after:
            report["structurallyClean"] = False
        doc = json.dumps(report, indent=1) + "\n"
        if o.out:
            fd = os.open(o.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(doc)
        else:
            sys.stdout.write(doc)
        if before != after:
            print("REFUSED: the database directory changed during a read-only check", file=sys.stderr); return 1
        return 0 if rc == 0 else 2
    except (Refused, OSError, ValueError) as e:
        print(f"REFUSED: {e}", file=sys.stderr); return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
