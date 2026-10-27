#!/usr/bin/env python3
"""compact-header-extraction-stage/r3 tests/make_meta_fixture.py (PREPARED by Claude 1892; NOT run by Claude). Review 1885 B3.

Builds ONE tiny ext4 qcow2 (meta.qcow2, 0444) in a NEW directory, with the SAME tools and helpers as the r9 fixture (pinned
recovery-overlay-stage/r9/fixture/make_fixture.py: mkfs.ext4 + debugfs -w on a private raw file; unprivileged), whose metadata
mirrors the PRODUCTION allowlist's hard cases so the e2e test exercises them through r9's `fuse2fs -o ro,norecovery,fakeroot` view:
  /data                         040750  uid 994 gid 985   (traversal by our non-owner user needs fakeroot)
  /data/reth.toml               0100640 uid 994 gid 985   2590 bytes  mtime 1793026310.098139981 (NON-ZERO nanoseconds = production's)
  /data/static_files            040755  uid 994 gid 985
  /data/static_files/h.conf     0100644 uid 994 gid 985   75 bytes    mtime 1000000000.000000000
The builder SELF-CHECKS every value with `debugfs stat` (independent of the code under test) and refuses otherwise. ~16 MiB raw
(sparse) + a small qcow2; the raw file is deleted. Never touches anything outside the new directory."""
import hashlib, importlib.util, json, os, re, sys

R9_FIXTURE = ("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r9/fixture/make_fixture.py",
              "7cece25eaa203c70af4ef9524fa1951e90f6fa697e784f75625b2017a52c3e48")
UUID = "5a5a5a5a-1111-4222-8333-944444444444"
BLOCK, FS_BLOCKS = 4096, 4096
UID, GID = 994, 985
FILES = [  # (path, mode, size, mtime_sec, mtime_nsec) - content is deterministic
    ("data/reth.toml", 0o100640, 2590, 1793026310, 98139981),
    ("data/static_files/h.conf", 0o100644, 75, 1000000000, 0),
]
DIRS = [("data", 0o040750), ("data/static_files", 0o040755)]


def mf():
    with open(R9_FIXTURE[0], "rb") as f:
        raw = f.read()
    if hashlib.sha256(raw).hexdigest() != R9_FIXTURE[1]:
        raise RuntimeError("r9 make_fixture.py is not the pinned file")
    spec = importlib.util.spec_from_loader("r9_make_fixture", loader=None)
    m = importlib.util.module_from_spec(spec); m.__file__ = R9_FIXTURE[0]
    exec(compile(raw, R9_FIXTURE[0], "exec"), m.__dict__)
    return m


def content(path, size):
    seed = hashlib.sha256(b"che-r2-meta " + path.encode()).digest()
    return (seed * (size // 32 + 1))[:size]


def commands(out):
    """the exact debugfs -w script (pure; unit-tested): dirs, files, then every inode field set explicitly"""
    c = [f"mkdir {d}" for d, _m in DIRS]
    for p, _m, size, _s, _n in FILES:
        c.append(f"write {out}/src-{os.path.basename(p)} {p}")
    for p, mode in DIRS + [(f[0], f[1]) for f in FILES]:
        c += [f"sif {p} mode 0{mode:o}", f"sif {p} uid {UID}", f"sif {p} gid {GID}"]
    for p, _m, _size, sec, nsec in FILES:
        c += [f"sif {p} mtime @{sec}", f"sif {p} mtime_extra {nsec << 2}"]           # ext4 extra: nsec << 2, epoch bits 0
    return c


def expected_allowlist():
    """the allowlist the e2e test uses: EVERY production metadata field, exact"""
    return [{"path": p, "size": size, "nlink": 1, "mode": mode, "uid": UID, "gid": GID, "mtime_ns": sec * 10**9 + nsec,
             "sha256": hashlib.sha256(content(p, size)).hexdigest()} for p, mode, size, sec, nsec in FILES]


STAT_RE = {"mode": re.compile(r"Mode:\s+0?([0-7]+)"), "user": re.compile(r"User:\s+(\d+)"), "group": re.compile(r"Group:\s+(\d+)"),
           "mtime": re.compile(r"mtime: 0x([0-9a-f]{8}):([0-9a-f]{8})"), "size": re.compile(r"Size:\s+(\d+)")}


def self_check(m, raw):
    for p, mode in DIRS + [(f[0], f[1]) for f in FILES]:
        st = m.debugfs(raw, f"stat {p}")
        got = {k: r.search(st) for k, r in STAT_RE.items()}
        if not (got["mode"] and int(got["mode"].group(1), 8) == mode & 0o7777 and got["user"] and int(got["user"].group(1)) == UID
                and got["group"] and int(got["group"].group(1)) == GID):
            raise RuntimeError(f"debugfs stat {p}: mode/uid/gid not as built: {st[:300]!r}")
    for p, _m, size, sec, nsec in FILES:
        st = m.debugfs(raw, f"stat {p}")
        mt, sz = STAT_RE["mtime"].search(st), STAT_RE["size"].search(st)
        if not (mt and int(mt.group(1), 16) == sec and int(mt.group(2), 16) == nsec << 2 and sz and int(sz.group(1)) == size):
            raise RuntimeError(f"debugfs stat {p}: size/mtime(ns) not as built: {st[:300]!r}")


def build(out):
    m = mf()
    os.mkdir(out, 0o700)
    raw = os.path.join(out, "meta.raw")
    with open(raw, "wb") as f:
        f.truncate(FS_BLOCKS * BLOCK)
    m.sh(["mkfs.ext4", "-F", "-q", "-b", "4096", "-I", "256", "-U", UUID, "-J", "size=4",
          "-O", "^metadata_csum_seed,^inline_data,metadata_csum,64bit,extent,huge_file,flex_bg,dir_index,filetype,extra_isize",
          "-E", f"lazy_itable_init=0,lazy_journal_init=0,root_owner={os.getuid()}:{os.getgid()}", raw])
    for p, _m, size, _s, _n in FILES:
        with open(os.path.join(out, f"src-{os.path.basename(p)}"), "wb") as f:
            f.write(content(p, size))
    script = os.path.join(out, "meta.debugfs")
    with open(script, "w") as f:
        f.write("\n".join(commands(out)) + "\n")
    m.debugfs_script(raw, script)
    self_check(m, raw)
    dst = os.path.join(out, "meta.qcow2")
    m.sh(["qemu-img", "convert", "-q", "-f", "raw", "-O", "qcow2", raw, dst])
    os.chmod(dst, 0o444)
    for p, *_r in FILES:
        os.unlink(os.path.join(out, f"src-{os.path.basename(p)}"))
    os.unlink(raw)
    with open(dst, "rb") as f:
        parent_sha = hashlib.sha256(f.read()).hexdigest()
    summary = {"parent": dst, "parentSha256": parent_sha, "uuid": UUID, "fsBlocks": FS_BLOCKS, "allowlist": expected_allowlist()}
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump(summary, f, indent=1)
    return summary


if __name__ == "__main__":
    if len(sys.argv) != 2 or not os.path.isabs(sys.argv[1]) or os.path.lexists(sys.argv[1]):
        print("usage: make_meta_fixture.py NEW_ABSOLUTE_DIR", file=sys.stderr); sys.exit(2)
    print(json.dumps(build(sys.argv[1])))
