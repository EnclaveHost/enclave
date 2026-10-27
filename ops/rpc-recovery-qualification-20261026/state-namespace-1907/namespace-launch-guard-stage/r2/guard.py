#!/usr/bin/env python3
"""namespace-launch-guard-stage/r2 guard.py (PREPARED by Claude 1901/1903; NOT run by Claude). Standard library + PINNED frozen code only.
r2 = r1 (674385ce..., actual unit run 8/9: test 3 dispatched a build with fuseblk on /var/tmp) + root 1903:
  * `unshare -m` clones the WHOLE mount namespace, not just the later rbind roots: BOTH routes now also refuse ANY non-desktop FUSE/fuseblk
    mount ANYWHERE (all_namespace_hazards); the only exception is fuse.portal / fuse.gvfsd-fuse under the ACTUAL /run/user/<uid>; stage
    mounts always refuse. The root-scoped pinned cnq.clone_hazards check is kept as well.
  * the discovered (unpinned) cnq receipt is parsed STRICTLY (no duplicate keys, no NaN/Infinity, an object) and accepted only if the
    pinned cnq.receipt_pass(inside, parent, uid) == [] AND format / pass / reasons / stageSums / ALL its pins are exactly the pinned ones.

A SMALL outer launch guard for review 1895 R1/R3, WITHOUT a new revision of the frozen stages: it runs OUTSIDE any namespace, BEFORE the
exact pinned entry of
  build-preflight | build                -> /usr/bin/bash <bsro r12>/jobs/build-outer.sh preflight|build
  capture-positive | capture-fixtures BD -> /usr/bin/bash <capture r3>/jobs/run.sh positive|fixtures BD
and refuses (rc 3, NO process created) unless:
  * every pinned stage (r12, capture r3, cnq r1, this stage) verifies against its pinned SUMS, file by file;
  * the route's ACTUAL prerequisite receipts are the pinned ones: r12 guard-tests + ns-tests (build), capture r3's 18-test receipt (capture),
    and for capture a PASSING actual cnq r1 namespace-qualification receipt (none exists yet: PENDING gate, refuses - never fabricated);
  * the route's roots are present and not symlinks: r12 RO_ROOTS (/home/steven /tmp) for the build; capture r3 ro_paths(uid) for the
    capture (its own symlink refusal included) - R3;
  * pinned cnq.clone_hazards finds NO stage mount anywhere and NO FUSE/fuseblk mount at or under a root (desktop portal/gvfs only under
    /run/user/<uid>) - R1. This REFUSES while e.g. the fuseblk .../tr004-readonly or a recovery stage FUSE view exists: wait for the
    coordinated cleanup after all 265; never detach, unmount or kill anything (this guard never does).
Then it records the roots and the clear check (runs/<route>-<UTC>-<pid>.json, O_EXCL) and os.execve's EXACTLY that argv (same pid,
so the queue's semantics are unchanged). It accepts no other command. Every original guard of the dispatched entry still runs after it.
Residual: a peer mount appearing between this check and the entry's own ns_harden would still be cloned (check-to-dispatch race); it is
closed only by the coordinated "no peer mounts during build/capture" window. Local evidence, not authentication against a malicious owner."""
import hashlib, json, os, re, stat, sys, time, types

W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
HERE = os.path.dirname(os.path.realpath(__file__))
R12, R3, CNQ = W + "/base-state-readonly-stage/r12", W + "/state-fixture-capture-stage/r3", W + "/capture-namespace-qualification-stage/r1"
SUMS = {R12: "2911943d8952c1b71aa54f1b2be1639b140d0521ca539b71424d63d20d9033ea",
        R3: "f5424d11fd3e7ee0251eaa55a177f6a3affa6e4b9b04b5e10c3e2f496b0488c2",
        CNQ: "ba3ee32d3d052b3ed79f1593b4318d52d933b68aa0471070db7a09c564486fd4"}
CODE = {"gate": (R12 + "/jobs/bsro_gate.py", "0641637ab6fa4bb007b7d97f4b1d1d3388b7815010f7b856e2f304b9cbb07dc4"),
        "capture": (R3 + "/capture.py", "81ddd643f41e91a16b6bda76d60873dda1d79ab066862b47c199958c072cc3e7"),
        "cnq": (CNQ + "/cnq.py", "66e715ee2ce6233aeb532cded94adc47a61aff1f70d7c5b759feba6115db0809"),
        "buildOuter": (R12 + "/jobs/build-outer.sh", "ad46ca167800881e0a2a811bd52ca10dab0ba2a4231cf4a55e5271f15f59397d"), "captureRun": (R3 + "/jobs/run.sh", "822788a255d1e85a1b761e7d2e152886cfeff61c8dc15c1a92dbfff0d72146e8")}
# ACTUAL receipts (root's runs, re-hashed 2026-10-27); a different byte refuses
RECEIPTS = {"r12Guard": (R12 + "/runs/guard-tests-20261027T103155Z-3085134/receipt.json", "8038eebeffa33905a52c67bb0c14cf41c13af6577c3c7e6113ecc3ab0593f29d"),
            "r12Ns": (R12 + "/runs/ns-tests-20261027T103547Z-3089579/receipt.json", "90a01d77d0f2f3bd525990becf8580e6aea01985e609de92f5a9c70dc4dfe337"),
            "r3Tests": (R3 + "/runs/tests-20261027T110224Z-3118540/receipt.json", "5fa5224c80365ccffb06f1920c393541625941a7554c565ae6c8ece697face0a")}
ROUTES = {"build-preflight": ("build", "preflight"), "build": ("build", "build"),
          "capture-positive": ("capture", "positive"), "capture-fixtures": ("capture", "fixtures")}
BD_RE = re.compile(r"/vm/enclave-volumes/rpc-recovery-validation-build/run-\d{8}T\d{6}Z-\d+/out")
ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "HOME": "/home/steven"}
CNQ_FORMAT = "capture-ns-qual-receipt/r1"


class Refused(Exception):
    pass


def refuse(m):
    raise Refused(m)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def read(path, cap=64 << 20):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            refuse(f"{path} is not a regular file")
        b = os.read(fd, cap + 1)
        if len(b) > cap:
            refuse(f"{path} exceeds {cap} bytes")
        return b
    finally:
        os.close(fd)


def verify_stage(d, want):
    raw = read(os.path.join(d, "SHA256SUMS"), 1 << 20)
    if sha(raw) != want:
        refuse(f"{d}/SHA256SUMS is not the pinned {want[:12]}")
    listed = {}
    for line in raw.decode().splitlines():
        m = re.fullmatch(r"([0-9a-f]{64})  ([^\s/][^\s]*)", line)
        if not m or ".." in m.group(2).split("/"):
            refuse(f"bad SUMS line in {d}")
        if sha(read(os.path.join(d, m.group(2)))) != m.group(1):
            refuse(f"{d}/{m.group(2)} != its SUMS entry")
        listed[m.group(2)] = m.group(1)
    return listed


def load(name):
    path, want = CODE[name]
    raw = read(path)
    if sha(raw) != want:
        refuse(f"{path} is not the pinned code")
    m = types.ModuleType(f"pinned_{name}"); m.__file__ = path
    exec(compile(raw, path, "exec"), m.__dict__)
    return m


def receipt(name):
    path, want = RECEIPTS[name]
    raw = read(path, 1 << 20)
    if sha(raw) != want:
        refuse(f"{name}: {path} is not the pinned actual receipt")
    return json.loads(raw)


# ---- pure ----------------------------------------------------------------------------------------------------------------------------
def parse_args(argv):
    """exactly: ROUTE (build-preflight|build) or ROUTE BD (capture-positive|capture-fixtures); nothing else"""
    if not argv or argv[0] not in ROUTES:
        refuse(f"route must be one of {sorted(ROUTES)}")
    kind, mode = ROUTES[argv[0]]
    if kind == "build":
        if len(argv) != 1:
            refuse("build routes take no further argument")
        return kind, mode, None
    if len(argv) != 2 or type(argv[1]) is not str or not BD_RE.fullmatch(argv[1]) or os.path.normpath(argv[1]) != argv[1]:
        refuse("capture routes take exactly one /vm/enclave-volumes/rpc-recovery-validation-build/run-<UTC>-<pid>/out")
    return kind, mode, argv[1]


def exact_argv(kind, mode, bd):
    if kind == "build":
        return ["/usr/bin/bash", CODE["buildOuter"][0], mode]
    return ["/usr/bin/bash", CODE["captureRun"][0], mode, bd]


DESKTOP_FUSE = ("fuse.portal", "fuse.gvfsd-fuse")
FUSE_TYPE = re.compile(r"^(fuse|fuseblk|fuse\..+)$")


def all_namespace_hazards(mountinfo, uid, stage_markers, Q):
    """r2 (root 1903): the WHOLE namespace is cloned by `unshare -m`: any FUSE/fuseblk mount ANYWHERE is a hazard, except the desktop
    portal/gvfs types at/under the ACTUAL /run/user/<uid>; any of our stage mounts anywhere is a hazard (pinned cnq.mounts parser)"""
    if type(uid) is not int or uid < 0:
        refuse("uid must be a non-negative int")
    ru = f"/run/user/{uid}"
    bad = []
    for m in Q.mounts(mountinfo):
        if any(sm in m["mp"] for sm in tuple(stage_markers) + Q.STAGE_EXTRA):
            bad.append(f"stage mount {m['mp']}")
        elif FUSE_TYPE.match(m["fstype"]) and not (m["fstype"] in DESKTOP_FUSE and Q.under(m["mp"], ru)):
            bad.append(f"FUSE {m['fstype']} at {m['mp']}")
    return bad


def roots_clear(roots, mountinfo, Q, stage_markers, exists=os.path.lexists, islink=os.path.islink, isdir=os.path.isdir):
    """-> the record; refuses on a missing/symlinked root or any clone hazard (pinned cnq.clone_hazards)"""
    for r in roots:
        if islink(r) or not exists(r) or not isdir(r):
            refuse(f"root {r} is missing, not a directory or a symlink")
    hz = Q.clone_hazards(mountinfo, roots, stage_markers)
    if hz:
        refuse(f"clone hazards at/under the roots (wait for the coordinated cleanup; nothing is detached here): {hz[:6]}")
    return {"roots": list(roots), "cloneHazards": [], "clear": True}


def strict_json(raw):
    """r2: the discovered (unpinned) cnq receipt: UTF-8, no duplicate keys, no NaN/Infinity, an object"""
    def pairs(ps):
        d = {}
        for k, v in ps:
            if k in d:
                raise ValueError(f"duplicate JSON key {k!r}")
            d[k] = v
        return d
    def nonfinite(c):
        raise ValueError(f"non-finite JSON constant {c}")
    r = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=pairs, parse_constant=nonfinite)
    if type(r) is not dict:
        raise ValueError("not a JSON object")
    return r


def cnq_receipt_errors(r, uid, capture_roots, Q):
    """r2: [] iff r is a passing ACTUAL cnq r1 receipt: the pinned cnq.receipt_pass(inside, parent, uid) == [] (every probe, every
    parent check, both phases, the full 5-root set) AND format / pass / reasons / stageSums / ALL pins exactly the pinned ones, AND the
    set is this host's capture r3 ro_paths(uid)"""
    if type(r) is not dict:
        return ["not an object"]
    e = []
    if r.get("format") != CNQ_FORMAT or r.get("pass") is not True or r.get("reasons") != []:
        e.append("not a passing capture-ns-qual-receipt/r1")
    if r.get("stageSums") != SUMS[CNQ]:
        e.append("stageSums is not the pinned cnq r1 SUMS")
    if r.get("pins") != {k: v[1] for k, v in Q.PINS.items()} or Q.PINS["r3Capture"][1] != CODE["capture"][1] \
            or Q.PINS["r3Sums"][1] != SUMS[R3] or Q.PINS["r12Sums"][1] != SUMS[R12]:
        e.append("its pins are not exactly the pinned cnq r1 pins (capture r3 / r12)")
    rp = Q.receipt_pass(r.get("inside"), r.get("parent"), uid)
    if rp:
        e.append(f"cnq.receipt_pass: {rp[:3]}")
    ins = r.get("inside")
    if type(ins) is not dict or ins.get("set") != list(capture_roots) or ins.get("r3RoPaths") != list(capture_roots):
        e.append("its hardened set is not this host's capture r3 ro_paths(uid)")
    return e


def find_cnq_receipt(runs_dir, capture_roots, uid, Q):
    """the newest PASSING actual cnq ns-qual receipt; none -> PENDING refusal (never fabricated)"""
    names = sorted((n for n in (os.listdir(runs_dir) if os.path.isdir(runs_dir) else []) if n.startswith("ns-qual-")), reverse=True)
    why = []
    for n in names:
        p = os.path.join(runs_dir, n, "receipt.json")
        try:
            raw = read(p, 1 << 20)
            r = strict_json(raw)
        except (OSError, ValueError, Refused) as e:
            why.append(f"{n}: {e}"); continue
        e = cnq_receipt_errors(r, uid, capture_roots, Q)
        if not e:
            return {"path": p, "sha256": sha(raw)}
        why.append(f"{n}: {e[:2]}")
    refuse(f"PENDING: no passing ACTUAL cnq r1 namespace-qualification receipt ({why[:3] or 'none exists'})")


# ---- the guard -----------------------------------------------------------------------------------------------------------------------
def main(argv=None, execve=os.execve, mountinfo=None, uid=None, fs=None, runs_dir=None, cnq_runs=None):
    argv = sys.argv[1:] if argv is None else argv
    fs = fs or {}
    try:
        kind, mode, bd = parse_args(argv)
        uid = os.getuid() if uid is None else uid
        own = verify_stage(HERE, sha(read(os.path.join(HERE, "SHA256SUMS"), 1 << 20)))
        listed = {d: verify_stage(d, s) for d, s in SUMS.items()}
        if listed[R12]["jobs/build-outer.sh"] != CODE["buildOuter"][1] or listed[R3]["jobs/run.sh"] != CODE["captureRun"][1]:
            refuse("the entry scripts are not the SUMS-listed ones")
        G, Q = load("gate"), load("cnq")
        rec = {"format": "namespace-launch-guard-record/r2", "route": argv[0], "uid": uid, "guardSums": sha(read(os.path.join(HERE, "SHA256SUMS"))),
               "stageSums": {os.path.basename(os.path.dirname(d)) + "/" + os.path.basename(d): s for d, s in SUMS.items()}}
        if kind == "build":
            g, n = receipt("r12Guard"), receipt("r12Ns")
            if not (g.get("pass") is True and n.get("pass") is True and g.get("stageSums") == SUMS[R12] == n.get("stageSums")):
                refuse("the pinned r12 guard/ns receipts are not passing receipts of r12")
            roots = list(G.RO_ROOTS)
            rec["receipts"] = {k: RECEIPTS[k][1] for k in ("r12Guard", "r12Ns")}
        else:
            t = receipt("r3Tests")
            if not (t.get("pass") is True and t.get("stageSums") == SUMS[R3] and t.get("ran") == ["18"]):
                refuse("the pinned capture r3 test receipt is not a passing 18-test receipt of r3")
            C = load("capture")
            roots = C.ro_paths(uid, **{k: fs[k] for k in ("exists", "islink") if k in fs})   # r3's own symlink refusal
            rec["receipts"] = {"r3Tests": RECEIPTS["r3Tests"][1], "cnqNsQual": find_cnq_receipt(cnq_runs or os.path.join(CNQ, "runs"), roots, uid, Q)}
        mi = mountinfo if mountinfo is not None else read("/proc/self/mountinfo", 4 << 20).decode()
        rec["check"] = roots_clear(roots, mi, Q, G.STAGE_MARKERS, **fs)
        hz = all_namespace_hazards(mi, uid, G.STAGE_MARKERS, Q)      # r2: the WHOLE namespace is cloned, for BOTH routes
        if hz:
            refuse(f"FUSE/stage mounts in the namespace that `unshare -m` would clone (wait for the coordinated cleanup): {hz[:6]}")
        rec["check"]["allNamespaceHazards"] = []
        rec["argv"] = exact_argv(kind, mode, bd)
        rec["checkedUtc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        rd = runs_dir or os.path.join(HERE, "runs")
        os.makedirs(rd, 0o700, exist_ok=True)
        fd = os.open(os.path.join(rd, f"{argv[0]}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{os.getpid()}.json"),
                     os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(rec, indent=1, sort_keys=True) + "\n"); f.flush(); os.fsync(f.fileno())
        print(json.dumps({"route": argv[0], "roots": roots, "clear": True, "dispatch": rec["argv"]}), flush=True)
    except Exception as e:                                              # noqa: BLE001 - incl. r3 ro_paths' own Refused: never dispatched
        print(f"## REFUSED (nothing dispatched): {type(e).__name__}: {e}"[:900], file=sys.stderr)
        return 3
    execve(rec["argv"][0], rec["argv"], dict(ENV))                     # the ONLY dispatch: exactly the pinned entry
    return 0                                                            # reached only with a mocked execve (tests)


if __name__ == "__main__":
    sys.exit(main())
