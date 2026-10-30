#!/usr/bin/env python3
"""capture-namespace-qualification-stage/r1 cnq.py (PREPARED by Claude 1895; NOT run by Claude). Standard library + PINNED frozen code.

A narrowly scoped ACTUAL namespace test of state-fixture-capture-stage/r3's read-only hardening (review 1884 B1, author 1889 U1):
the r3 path set /home/steven /tmp + /var/tmp /dev/shm /run/user/<uid>, bound by the PINNED r12 jobs/ns.sh `ns_harden` exactly as r3
jobs/inner.sh does, then VERIFIED with the PINNED r12 bsro_gate.ns_checks (private propagation + read_only + ro_tree_ok). No fixture,
build, helper, part, backup or original is touched; the only writes are tiny probe/marker files in a NEW /vm work dir.

  cnq.py precheck UID WORK        OUTSIDE (before any namespace clones a mount): every root exists and is not a symlink; no recovery/
                                  composite/extraction stage mount and no recovery FUSE view (nbdfuse/fuse2fs/fuseblk) at or under the
                                  roots (pinned r12 STAGE_MARKERS + this filter; no driver hold); WORK is a NEW empty 0700 dir on /vm
  cnq.py inside UID WORK          INSIDE (after ns_harden): ns_checks over the exact set (ro) and WORK (rw); the bash set == pinned capture
                                  r3 ro_paths(uid); an O_CREAT probe in EVERY root fails with EROFS; a write in WORK succeeds; -> inside.json
  cnq.py parent UID WORK          OUTSIDE, while the namespace is alive: every root is still NOT read-only for the parent, the parent's
                                  mount table at the roots is unchanged -> parent.json
  cnq.py receipt WORK OUTDIR      combines the phase files into ONE receipt; pass only if EVERY check of EVERY root ran and held
Exit 0 pass, 3 refused (nothing cloned), 4 failed. A missing root is a refusal, never a skip."""
import hashlib, json, os, re, stat, sys, time, types

W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
PINS = {
    "r12Sums": (W + "/base-state-readonly-stage/r12/SHA256SUMS", "2911943d8952c1b71aa54f1b2be1639b140d0521ca539b71424d63d20d9033ea"),
    "r12Gate": (W + "/base-state-readonly-stage/r12/jobs/bsro_gate.py", "0641637ab6fa4bb007b7d97f4b1d1d3388b7815010f7b856e2f304b9cbb07dc4"),
    "r12Ns": (W + "/base-state-readonly-stage/r12/jobs/ns.sh", "b8b4560c160b68ce8f855e2ce2a7f52128c5d16a43d392c62ba6030a6fa28751"),
    "r3Sums": (W + "/state-fixture-capture-stage/r3/SHA256SUMS", "f5424d11fd3e7ee0251eaa55a177f6a3affa6e4b9b04b5e10c3e2f496b0488c2"),
    "r3Capture": (W + "/state-fixture-capture-stage/r3/capture.py", "81ddd643f41e91a16b6bda76d60873dda1d79ab066862b47c199958c072cc3e7"),
    "r3Inner": (W + "/state-fixture-capture-stage/r3/jobs/inner.sh", "51bc15a946275082303e9dc4a5e51e7746868d5cf6f9a6ac6f72e8ed5dc03414"),
}
WORK_PARENT = "/vm/enclave-volumes/tr004-base-recovery-20261026"
WORK_RE = re.compile(re.escape(WORK_PARENT) + r"/capture-ns-qual-\d{8}T\d{6}Z-\d+")
FUSE = re.compile(r"^(fuse|fuseblk|fuse\..+)$")
DESKTOP_FUSE = ("fuse.portal", "fuse.gvfsd-fuse")                  # tolerated ONLY under /run/user/<uid> (cloned read-only; recorded)
STAGE_EXTRA = ("/compact-header-extraction-stage/", "/state-fixture-capture-stage/", "/capture-namespace-qualification-stage/")
RECEIPT_FORMAT = "capture-ns-qual-receipt/r1"


class Refused(Exception):
    pass


def refuse(m):
    raise Refused(m)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def load_pinned(name, modname):
    path, want = PINS[name]
    with open(path, "rb") as f:
        raw = f.read()
    if sha(raw) != want:
        refuse(f"{name}: {path} is not the pinned {want[:12]}")
    m = types.ModuleType(modname); m.__file__ = path
    exec(compile(raw, path, "exec"), m.__dict__)
    return m


def check_pins():
    for name, (path, want) in PINS.items():
        with open(path, "rb") as f:
            if sha(f.read()) != want:
                refuse(f"{name} is not the pinned file")
    return True


# ---- pure (tests/test_cnq.py) ------------------------------------------------------------------------------------------------------
def roots(uid):
    """exactly r3's set on a host where every extra path exists (a missing root is a REFUSAL here: no skip-as-pass)"""
    return ["/home/steven", "/tmp", "/var/tmp", "/dev/shm", f"/run/user/{uid}"]


def mounts(mountinfo):
    out = []
    for line in mountinfo.splitlines():
        pre, _, post = line.partition(" - ")
        a, b = pre.split(), post.split()
        if len(a) >= 6 and len(b) >= 2:
            mp = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), a[4])
            out.append({"id": int(a[0]), "parent": int(a[1]), "mp": mp, "opts": a[5].split(","), "fstype": b[0], "source": b[1]})
    return out


def under(mp, r):
    return mp == r or mp.startswith(r.rstrip("/") + "/")


def clone_hazards(mountinfo, roots_, stage_markers):
    """mounts a recursive bind of the roots would CLONE and pin (a peer's or a session's FUSE server could not finish while our namespace
    holds the clone): any of our stages' mounts anywhere, and ANY FUSE mount at/under a root - except the desktop portal/gvfs types under
    /run/user/<uid> (conservative: nbdfuse/fuse2fs/qemu views of the original or backup are always refused, whatever their fstype)"""
    bad = []
    run_user = [r for r in roots_ if r.startswith("/run/user/")]
    for m in mounts(mountinfo):
        if any(s in m["mp"] for s in tuple(stage_markers) + STAGE_EXTRA):
            bad.append(f"stage mount {m['mp']}")
        elif any(under(m["mp"], r) for r in roots_) and FUSE.match(m["fstype"]):
            if not (m["fstype"] in DESKTOP_FUSE and any(under(m["mp"], r) for r in run_user)):
                bad.append(f"FUSE view {m['fstype']} at {m['mp']}")
    return bad


def at_roots(mountinfo, roots_):
    """the parent's visible mount table at/under the roots (for the 'unchanged in the parent' check)"""
    return sorted([m["mp"], m["fstype"], ",".join(sorted(m["opts"]))] for m in mounts(mountinfo) if any(under(m["mp"], r) for r in roots_))


def receipt_pass(inside, parent, uid):
    """[] iff both phase records exist and EVERY root has every check true (exact keys; no skipped root)"""
    e, rs = [], roots(uid)
    if type(inside) is not dict or type(parent) is not dict:
        return ["a phase record is missing"]
    if inside.get("set") != rs or inside.get("bashSet") != rs or inside.get("r3RoPaths") != rs:
        e.append("the hardened set is not exactly r3's 5 roots (bash, r3 ro_paths, expected)")
    if inside.get("nsChecks") is not True or inside.get("workWritable") is not True or inside.get("symlinkRefused") is not True \
            or inside.get("heredocOk") is not True:
        e.append("inside: ns_checks / WORK writable / symlink refusal / heredoc not all true")
    pr = inside.get("probes")
    if type(pr) is not dict or sorted(pr) != sorted(rs) or any(v != "EROFS" for v in pr.values()):
        e.append(f"inside: not every root refused an O_CREAT probe with EROFS: {pr}")
    pw = parent.get("writable")
    if type(pw) is not dict or sorted(pw) != sorted(rs) or any(v is not True for v in pw.values()):
        e.append(f"parent: a root became read-only for the parent: {pw}")
    if parent.get("mountsUnchanged") is not True or parent.get("innerAlive") is not True:
        e.append("parent: mount table changed or the namespace was not alive during the check")
    return e


# ---- phases --------------------------------------------------------------------------------------------------------------------------
def work_ok(work, must_be_empty):
    if not (type(work) is str and WORK_RE.fullmatch(work) and os.path.realpath(work) == work):
        refuse(f"{work!r} is not a {WORK_PARENT}/capture-ns-qual-<UTC>-<pid> real dir")
    st = os.lstat(work)
    if not stat.S_ISDIR(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o700 or (must_be_empty and os.listdir(work)):
        refuse(f"{work} is not a 0700 directory{' and empty' if must_be_empty else ''}")
    if f"{os.major(st.st_dev)}:{os.minor(st.st_dev)}" != "253:1":
        refuse(f"{work} is not on the pinned /vm (253:1)")


def write_new(path, obj):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(obj, indent=1, sort_keys=True) + "\n"); f.flush(); os.fsync(f.fileno())


def precheck(uid, work):
    check_pins()
    G = load_pinned("r12Gate", "bsro_gate_r12")
    rs = roots(uid)
    for r in rs:
        if os.path.islink(r) or not os.path.isdir(r):
            refuse(f"{r}: missing or a symlink (this qualification requires r3's full path set: no skip-as-pass)")
    hz = clone_hazards(G.read_all("/proc/self/mountinfo", 4 << 20).decode(), rs, G.STAGE_MARKERS)
    if hz:
        refuse(f"refusing before any namespace clone: {hz[:5]}")
    work_ok(work, True)
    write_new(os.path.join(work, "parent-before.json"), {"atRoots": at_roots(G.read_all("/proc/self/mountinfo", 4 << 20).decode(), rs)})
    return 0


def inside(uid, work, bash_set):
    check_pins()
    G = load_pinned("r12Gate", "bsro_gate_r12")
    C = load_pinned("r3Capture", "capture_r3")
    rs = roots(uid)
    rec = {"set": rs, "bashSet": bash_set.split(), "r3RoPaths": C.ro_paths(uid)}
    mi = G.read_all("/proc/self/mountinfo", 4 << 20).decode()
    try:
        rec["nsChecks"] = G.ns_checks(mi, [*rs, os.path.dirname(PINS["r3Sums"][0]), os.path.dirname(PINS["r12Sums"][0])],
                                      [work], tuple(rs)) is True
    except Exception as e:                                              # noqa: BLE001
        rec["nsChecks"], rec["nsChecksError"] = False, f"{type(e).__name__}: {e}"[:400]
    rec["probes"] = {}
    for r in rs:
        p = os.path.join(r, f".cnq-probe-{os.getpid()}")
        try:
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except OSError as e:
            rec["probes"][r] = "EROFS" if e.errno == 30 else f"errno {e.errno}"
        else:
            os.close(fd); os.unlink(p)                                  # it should never happen: removed at once, and FAILS
            rec["probes"][r] = "CREATED (not read-only!)"
    try:
        write_new(os.path.join(work, "rw-probe"), {"ok": True}); rec["workWritable"] = True
    except OSError:
        rec["workWritable"] = False
    rec["symlinkRefused"] = os.environ.get("CNQ_SYMLINK_RC") == "9"
    rec["heredocOk"] = os.environ.get("CNQ_HEREDOC") == "ok"
    write_new(os.path.join(work, "inside.json"), rec)
    return 0


def parent(uid, work, inner_pid):
    G = load_pinned("r12Gate", "bsro_gate_r12")
    rs = roots(uid)
    with open(os.path.join(work, "parent-before.json")) as f:
        before = json.load(f)["atRoots"]
    rec = {"writable": {r: not (os.statvfs(r).f_flag & os.ST_RDONLY) and os.access(r, os.W_OK) for r in rs},
           "mountsUnchanged": at_roots(G.read_all("/proc/self/mountinfo", 4 << 20).decode(), rs) == before,
           "innerAlive": os.path.exists(f"/proc/{inner_pid}")}
    write_new(os.path.join(work, "parent.json"), rec)
    return 0


def receipt(uid, work, outdir):
    def load(n):
        try:
            with open(os.path.join(work, n)) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None
    ins, par = load("inside.json"), load("parent.json")
    errs = receipt_pass(ins, par, uid)
    rec = {"format": RECEIPT_FORMAT, "pass": not errs, "reasons": errs, "inside": ins, "parent": par, "pins": {k: v[1] for k, v in PINS.items()},
           "scope": "namespace hardening of capture r3's path set only: NOT a fixture, build, capture or state qualification"}
    with open(os.path.join(os.path.dirname(os.path.realpath(__file__)), "SHA256SUMS"), "rb") as f:
        rec["stageSums"] = sha(f.read())
    write_new(os.path.join(outdir, "receipt.json"), rec)
    print(json.dumps({"pass": rec["pass"], "reasons": errs[:5]}))
    return 0 if rec["pass"] else 4


def main(argv=None):
    a = sys.argv[1:] if argv is None else argv
    try:
        if len(a) == 3 and a[0] == "precheck":
            return precheck(int(a[1]), a[2])
        if len(a) == 4 and a[0] == "inside":
            return inside(int(a[1]), a[2], a[3])
        if len(a) == 4 and a[0] == "parent":
            return parent(int(a[1]), a[2], int(a[3]))
        if len(a) == 4 and a[0] == "receipt":
            return receipt(int(a[1]), a[2], a[3])
    except Refused as e:
        print(f"## REFUSED: {e}", file=sys.stderr); return 3
    except Exception as e:                                              # noqa: BLE001
        print(f"## FAILED: {type(e).__name__}: {e}", file=sys.stderr); return 4
    print("usage: cnq.py precheck UID WORK | inside UID WORK BASHSET | parent UID WORK INNERPID | receipt UID WORK OUTDIR", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
