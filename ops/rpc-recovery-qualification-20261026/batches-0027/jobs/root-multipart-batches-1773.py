#!/usr/bin/env python3
"""jobs/root-multipart-batches-1773.py (PREPARED by Claude 1773; NOT run by Claude). Standard library + the FROZEN multipart r3 core.
1773 = 1764 (preserved unchanged) + root's pre-activation corrections:
  * a DURABLE stop intent: the driver's SIGTERM/SIGINT writes OUT/STOP (O_EXCL) under OUT/stop.lock (flock). The queued batch job
    checks STOP at its start (before any pin, admission or active.json), again before admission, and finally UNDER the same flock
    immediately before launching the wrapper: a stop recorded before that point can never start production; a stop recorded after it
    is a stop of a RUNNING batch and is forwarded to its orchestrate.py. The driver never launches a queue job once stop is set.
  * the driver retries the forward in its poll loop until it succeeds (the batch job may register itself much later than the signal:
    it can wait in the queue); the batch job likewise retries the forward to orchestrate.py while its wrapper runs.
  * strict inventory: a part-NNNN.* name whose index is not in the manifest, or that lies in the WRONG target dir, is foreign.
  * source pin: the driver hashes this runner file, records the sha256 in run.lock and passes it to every queued batch job, which
    refuses unless its own file still has that sha256 (and `drive --runner-sha256 H` may pin the expected value up front).
  * --queue-cmd: TEST ONLY substitute for jobs/q-exit-status.sh (owned delayed-queue fixtures); root never passes it.
  review 1772 (verified): the batch installs its signal handler BEFORE registering active.json; verify-/resume- names must carry a
  run id; a post-check error after the wrapper ran is rc 4 (never "admission refused"); the orchestrate match compares realpaths.

Batched production preservation of parts 1..264 (part 0 already copied + independently verified by root), with the UNCHANGED
qualified r3 wrapper (recovery-multipart-stage/r3/jobs/root-preservation.sh: r9 guards, original read-only, peer snapshot) and the
shared queue (jobs/q-exit-status.sh, 1024 MiB per job). Batches of <= 8 parts; per batch: COPY (one new r9 session), then VERIFY the
same parts in a NEW session. Strictly sequential: never two sessions or view mounts at once.

  drive --out NEWDIR [--start 1] [--stop 264]     the OUTER driver; NOT itself in the queue. For each batch and mode it runs ONE queue
                                                   child  bash jobs/q-exit-status.sh <name> 1024 python3 -I -B THIS batch ...
                                                   and waits; any non-zero rc stops everything. NEWDIR gets run.lock (O_EXCL) and
                                                   batches.jsonl. SIGTERM/SIGINT: no new job; the signal is forwarded ONCE to the
                                                   pidfd-pinned in-queue batch job (our own descendant), which forwards it to the
                                                   pidfd-pinned orchestrate.py under its own wrapper child -> orchestrate cancels at
                                                   a safe point, the r9 session cleans up, the wrapper finishes its peer checks. No
                                                   process group is ever signalled (the queue's own stop() would SIGKILL a session
                                                   after 1 s - it is never triggered by us).
  batch --mode copy|verify --lo L --hi H --out DIR --run-id ID     the QUEUED job: a FRESH admission immediately before the wrapper:
       - the frozen r3 stage SUMS (before import), the exact manifest / request sha256s, the driver's run lock
       - no other r9 / multipart session process and no stage view mount anywhere (fixture runs of the same stages included)
       - every existing file in both target dirs is one of ours (marker, part-NNNN.*, session-*.json); anything else refuses
       - every part < L: committed (valid record, CURRENT lstat == destIdentity, nlink 1, confirmed binding) AND a strictly valid
         PASS verify record measured after the commit, identity-matching, in a CONFIRMED session (never a saved hash alone)
       - copy: every part >= L has NO file at all (a fresh run: partial / stale / foreign state refuses; explicit resume = future)
         verify: parts L..H committed in a confirmed session and not yet verified (only .bin + .json); parts > H: no file
       - per target: free >= (FULL remaining logical reservation: every not-committed part's exact manifest length) + the 40 GiB
         manifest floor + 8 GiB extra on root
       then root-preservation.sh MODE L-H (own child, own session); after rc 0 the post-checks:
       - copy: every part L..H committed in exactly ONE session that did not exist at admission and is CONFIRMED in its target(s);
         parts > H untouched; parts < L still valid
       - verify: every part L..H has a PASS in ONE NEW confirmed session (not the copy session); r3 status shows no stale /
         unconfirmed / invalid / failed part; parts < L still valid
Exit: 0 ok; 3 admission refused (nothing started); 4 post-check failed; otherwise the wrapper/queue rc. Every outcome is preserved
(parts, records, receipts); nothing is deleted, renamed or resumed automatically. NOT a recovery acceptance or RAID reset."""
import argparse, contextlib, fcntl, hashlib, json, os, re, signal, stat, subprocess, sys, time
from pathlib import Path

W = Path("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025")
STAGE = W / "recovery-multipart-stage/r3"
STAGE_SUMS = "fcd8e0973597eebb7a003becca05f8695e770dd797a974f2bf7ce1beb041fe20"
B = W.parent.parent / "outputs/rpc-production-final-20261025/base-multipart-production-20261026"
PIN = {"manifest": "f94807f71c93b1ef639c224dfefb3b6c0f3e7b9289def91fc52b0e79864821a9",
       "copy": "ad14886f5def97feb75d8a588a751d658e29eb8d78c8c136e789fd5b73d4948d",
       "verify": "1728b7b67c9718fb2ca673c2e865914df0ed393a777d3e138bdd593496839cfa"}
EXTERNAL = {"root": 8 << 30, "vm": 0}                                # the additional root reservation (native build)
FIRST, LAST, BATCH, QUEUE_MIB = 1, 264, 8, "1024"
QUEUE = str(W / "jobs/q-exit-status.sh")
SCRIPT = Path(os.path.realpath(__file__))
RUNID = re.compile(r"\d{8}T\d{6}Z-\d{1,10}")


def die(rc, msg):
    print(f"## { {3: 'REFUSED', 4: 'FAILED', 5: 'STOPPED'}.get(rc, f'rc {rc}')}: {msg}", file=sys.stderr)
    raise SystemExit(rc)


def verify_stage():
    raw = (STAGE / "SHA256SUMS").read_bytes()
    if hashlib.sha256(raw).hexdigest() != STAGE_SUMS:
        die(3, "multipart r3 SHA256SUMS changed")
    for line in raw.decode().splitlines():
        h, _, name = line.partition("  ")
        if hashlib.sha256((STAGE / name).read_bytes()).hexdigest() != h:
            die(3, f"multipart r3 file {name} changed")


verify_stage()                                                       # BEFORE importing the frozen core
sys.path.insert(0, str(STAGE)); sys.dont_write_bytecode = True
import multipart as MP  # noqa: E402


def batches(start=FIRST, stop=LAST, size=BATCH):
    if not (FIRST <= start <= stop <= LAST) or not 1 <= size <= BATCH:
        raise ValueError(f"need {FIRST} <= start <= stop <= {LAST} and 1 <= size <= {BATCH}")
    return [(lo, min(lo + size - 1, stop)) for lo in range(start, stop + 1, size)]


# ---- part state, exactly as the r3 core judges it (r3 status rules, per part) -------------------------------------------------
PART_RE = re.compile(r"part-(\d{4})\.(bin|json|ckpt\.json|bin\.partial|(?:verify|resume)-\d{8}T\d{6}Z-\d{1,10}\.json)")
SESSION_RE = re.compile(r"session-(\d{8}T\d{6}Z-\d{1,10})\.json")


def inventory(dfd, d, target):
    """-> ({index: [names]}, foreign names, session ids) of one target dir. 1773: a part name whose index is not in the manifest or
    whose manifest target is ANOTHER dir is foreign"""
    owner = {p["index"]: p["target"] for p in d["parts"]}
    per, foreign, sessions = {}, [], set()
    for n in sorted(os.listdir(dfd)):
        m = PART_RE.fullmatch(n)
        if m and owner.get(int(m[1])) != target:
            foreign.append(n)
        elif m:
            per.setdefault(int(m[1]), []).append(n)
        elif SESSION_RE.fullmatch(n):
            sessions.add(SESSION_RE.fullmatch(n)[1])
        elif n != MP.MARKER:
            foreign.append(n)
    return per, foreign, sessions


def part_state(d, msha, p, dfd, cache):
    """committed / verified (with session ids) for ONE part, by the r3 core's own record rules; never a saved hash alone"""
    s = {"committed": False, "verified": False, "commitSession": None, "verifySessions": set(), "failed": False, "why": None}
    if not MP.exists_in(dfd, MP.rec_name(p)):
        s["why"] = "no commit record"; return s
    try:
        r = MP.load_record(dfd, p, msha)
    except MP.Fail as e:
        s["why"] = f"invalid record: {e}"; return s
    try:
        st = os.lstat(p["file"], dir_fd=dfd)
    except FileNotFoundError:
        s["why"] = "part file missing"; return s
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or MP.dident(st) != r["destIdentity"] or st.st_size != p["length"]:
        s["why"] = "stale: the part file's identity differs from its record"; return s
    commit_ok = MP.binding_counts(d, r["source"], dfd, cache)
    s["commitSession"] = r["source"].get("sessionId")
    pref = p["file"][:-4] + ".verify-"
    for n in sorted(os.listdir(dfd)):
        if not (n.startswith(pref) and n.endswith(".json")):
            continue
        try:
            x = MP.read_json_in(dfd, n, "verify")
        except MP.Fail:
            s["failed"] = True; s["why"] = f"unreadable verify record {n}"; continue
        good = isinstance(x, dict) and set(x) == MP.VER_KEYS and x["format"] == MP.FMT["verify"] and x["manifestSha256"] == msha \
            and x["index"] == p["index"] and x["status"] in ("PASS", "FAIL") and isinstance(x["run"], str) and RUNID.fullmatch(x["run"]) \
            and n == pref + x["run"] + ".json" and isinstance(x["destIdentity"], dict) and MP.valid_binding(x["source"]) and MP._int(x["measuredAtNs"])
        if not good or x["status"] == "FAIL":
            s["failed"] = True; s["why"] = f"invalid or FAIL verify record {n}"; continue
        if x["destIdentity"] == r["destIdentity"] == MP.dident(st) and x["recordSha256"] == r["logicalSha256"] \
                and x["sourceSha256"] == x["destinationSha256"] == r["logicalSha256"] and x["measuredAtNs"] > r["committedAtNs"] \
                and MP.binding_counts(d, x["source"], dfd, cache):
            s["verified"] = True; s["verifySessions"].add(x["source"].get("sessionId"))
    s["committed"] = commit_ok or s["verified"]
    if not s["committed"]:
        s["why"] = "commit binding not confirmed and no confirmed fresh PASS"
    return s


class Targets:
    def __init__(self, d, check_uuid=True):
        self.fd = {}
        try:
            for name, v in d["targets"].items():
                fd = MP.open_dir(v["dir"], f"target {name}")
                self.fd[name] = fd
                if MP.majmin(os.fstat(fd).st_dev) != v["majmin"]:
                    die(3, f"target {name}: filesystem differs from the manifest pin")
                if check_uuid:
                    u, mm = MP.findmnt_uuid(v["dir"])
                    if (u, mm) != (v["uuid"], v["majmin"]) or MP.is_usb(mm):
                        die(3, f"target {name}: UUID/device differ or USB")
        except BaseException:
            self.close(); raise

    def close(self):
        for fd in self.fd.values():
            with contextlib.suppress(OSError):
                os.close(fd)
        self.fd = {}


def free_bytes(fd):
    v = os.statvfs(fd)
    return v.f_bavail * v.f_frsize


def admit(d, msha, lo, hi, mode, free=free_bytes, check_uuid=True):
    """the FRESH admission (run inside the queued job, right before the wrapper); -> the admission record; refuses (rc 3)"""
    tg = Targets(d, check_uuid)
    try:
        cache, inv, sessions = {}, {}, {}
        for name, fd in tg.fd.items():
            per, foreign, ses = inventory(fd, d, name)
            if foreign:
                die(3, f"target {name}: files that are not ours: {foreign[:8]}")
            inv[name], sessions[name] = per, sorted(ses)
        states, remaining = {}, {n: 0 for n in tg.fd}
        for p in d["parts"]:
            i, name = p["index"], p["target"]
            names = inv[name].get(i, [])
            st = part_state(d, msha, p, tg.fd[name], cache) if names else {"committed": False, "verified": False, "why": "no files"}
            states[i] = st
            if i < lo:
                if not (st["committed"] and st["verified"]) or st.get("failed"):
                    die(3, f"previous part {i} is not committed + verified in confirmed sessions: {st['why']}")
                if any(n.endswith((".partial", ".ckpt.json")) for n in names):
                    die(3, f"previous part {i} has partial/checkpoint leftovers")
            elif mode == "verify" and i <= hi:
                if sorted(names) != sorted([p["file"], MP.rec_name(p)]) or not st["committed"] or st["verified"]:
                    die(3, f"part {i} is not exactly committed (confirmed) and unverified: {names} {st.get('why')}")
            elif names:
                die(3, f"part {i} already has files {names[:6]} (a fresh run never adopts partial/stale/foreign state)")
            if not st["committed"]:
                remaining[name] += p["length"]                       # the exact manifest length of every not-committed part
        checks = {}
        for name, fd in tg.fd.items():
            need = remaining[name] + d["targets"][name]["floorBytes"] + EXTERNAL.get(name, 0)
            have = free(fd)
            checks[name] = {"freeBytes": have, "remainingLogicalBytes": remaining[name], "floorBytes": d["targets"][name]["floorBytes"],
                            "externalReservationBytes": EXTERNAL.get(name, 0), "neededBytes": need, "marginBytes": have - need}
            if have < need:
                die(3, f"target {name}: free {have} < needed {need} (remaining {remaining[name]} + floor + external)")
        return {"mode": mode, "lo": lo, "hi": hi, "atEpoch": time.time(), "manifestSha256": msha, "capacity": checks,
                "sessionsBefore": sessions}
    finally:
        tg.close()


def post_check(d, msha, lo, hi, mode, adm, check_uuid=True):
    """after the wrapper's rc 0; -> summary; failures rc 4"""
    tg = Targets(d, check_uuid)
    try:
        cache, before = {}, {s for v in adm["sessionsBefore"].values() for s in v}
        new = set()
        for p in d["parts"]:
            i, fd = p["index"], tg.fd[p["target"]]
            per, foreign, _ = inventory(fd, d, p["target"])
            if foreign:
                die(4, f"foreign files appeared in target {p['target']}: {foreign[:8]}")
            if i > hi:
                if per.get(i):
                    die(4, f"part {i} outside the batch has files {per[i][:6]}")
                continue
            st = part_state(d, msha, p, fd, cache)
            if i < lo:
                if not (st["committed"] and st["verified"]) or st["failed"]:
                    die(4, f"previous part {i} no longer valid: {st['why']}")
                continue
            if not st["committed"] or st["failed"]:
                die(4, f"part {i}: {st['why']}")
            if mode == "copy":
                if st["commitSession"] in before or not MP.session_confirmed(fd, MP.load_record(fd, p, msha)["source"], cache):
                    die(4, f"part {i} is not bound to a NEW confirmed session")
                new.add(st["commitSession"])
            else:
                fresh = st["verifySessions"] - before - {st["commitSession"]}
                if not st["verified"] or len(fresh) != 1:
                    die(4, f"part {i} has no PASS in exactly one NEW confirmed verify session ({sorted(st['verifySessions'])})")
                new |= fresh
        if len(new) != 1:
            die(4, f"the batch is bound to {len(new)} new sessions (exactly one expected): {sorted(new)}")
        out = {"newSession": new.pop()}
        if mode == "verify":
            s = MP.status(d, msha)
            if s["stale"] or s["unconfirmed"] or s["invalidRecords"] or s["failedVerification"]:
                die(4, f"r3 status not clean: {s}")
            out["status"] = {k: s[k] for k in ("partsCommitted", "partsVerifiedRecorded", "copyComplete", "verificationCompleteRecorded")}
        return out
    finally:
        tg.close()


# ---- processes: only our own descendants, pidfd-pinned ---------------------------------------------------------------------------
def parents():
    out = {}
    for e in os.listdir("/proc"):
        if e.isdigit():
            with contextlib.suppress(OSError, ValueError, IndexError):
                s = Path(f"/proc/{e}/stat").read_text()
                out[int(e)] = int(s[s.rindex(")") + 2:].split()[1])
    return out


def descendants(root):
    par, owned = parents(), {root}
    while True:
        more = owned | {p for p, pp in par.items() if pp in owned}
        if more == owned:
            return owned - {root}
        owned = more


def cmdline(pid):
    return [x.decode(errors="replace") for x in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")[:-1]]


def starttime(pid):
    s = Path(f"/proc/{pid}/stat").read_text()
    return int(s[s.rindex(")") + 2:].split()[19])


def find_descendant(root, match):
    """-> (pidfd, pid) of the ONE descendant of `root` whose cmdline satisfies match (re-verified after pidfd_open), else None"""
    hits = []
    for pid in sorted(descendants(root)):
        with contextlib.suppress(OSError):
            if match(cmdline(pid)):
                hits.append(pid)
    if len(hits) != 1:
        return None
    pid = hits[0]
    try:
        fd = os.pidfd_open(pid)
    except OSError:
        return None
    with contextlib.suppress(OSError):
        if pid in descendants(root) and match(cmdline(pid)):
            return fd, pid
    os.close(fd)
    return None


def is_orchestrate(cmd):
    return len(cmd) >= 5 and cmd[0].endswith("python3") and cmd[4] == "run" and \
        os.path.realpath(cmd[3]) == os.path.realpath(STAGE / "orchestrate.py")     # 1772 P3-2: the wrapper passes a pwd -P path


def busy_reasons(mountinfo, procs, me):
    """another r9 / multipart session or a stage view mount (fixture runs included) blocks a batch: one view at a time"""
    why = [l.split()[4] for l in mountinfo.splitlines() if "/recovery-multipart-stage/" in l or "/recovery-overlay-stage/" in l]
    for pid, cmd in procs:
        if pid != me and any(c.endswith(("overlay_session.py", "/orchestrate.py")) for c in cmd[:4]):
            why.append(f"pid {pid}: {' '.join(cmd[:5])}")
    return why


def all_procs():
    out = []
    for e in os.listdir("/proc"):
        if e.isdigit():
            with contextlib.suppress(OSError):
                out.append((int(e), cmdline(int(e))))
    return out


def log(out_dir, rec):
    fd = os.open(os.path.join(out_dir, "batches.jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.write(fd, (json.dumps({"atEpoch": time.time(), **rec}, sort_keys=True, default=str) + "\n").encode()); os.fsync(fd)
    finally:
        os.close(fd)


def new_json(path, obj):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(obj, indent=1, sort_keys=True, default=str) + "\n"); f.flush(); os.fsync(f.fileno())


# ---- the durable stop intent ----------------------------------------------------------------------------------------------------
def stop_path(out):
    return os.path.join(out, "STOP")


def stop_requested(out):
    return os.path.lexists(stop_path(out))


@contextlib.contextmanager
def stop_lock(out):
    fd = os.open(os.path.join(out, "stop.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)                                                 # closing releases the flock


def write_stop(out, why):
    """the driver's durable stop intent; ordered against the batch's final pre-launch check by stop.lock"""
    with stop_lock(out):
        if not stop_requested(out):
            new_json(stop_path(out), {"why": why, "atEpoch": time.time(), "pid": os.getpid()})


def guarded_launch(out, own_stop, launch):
    """-> launch() or None: the LAST stop check and the launch happen under stop.lock, so a recorded stop never starts production"""
    with stop_lock(out):
        if own_stop() or stop_requested(out):
            return None
        return launch()


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ---- the queued batch job -------------------------------------------------------------------------------------------------------
def cmd_batch(a):
    out = a.out
    try:
        lock = json.loads(Path(out, "run.lock").read_text())
    except (OSError, ValueError):
        die(3, "no driver run lock")
    if lock.get("runId") != a.run_id or lock.get("runnerSha256") != a.runner_sha256 or file_sha(SCRIPT) != a.runner_sha256:
        die(3, "run lock / runner sha256 mismatch: this job is not the driver's pinned runner")
    tag = {"job": "batch", "mode": a.mode, "lo": a.lo, "hi": a.hi, "runId": a.run_id}
    if stop_requested(out):                                          # 1773: before ANY pin, admission or registration
        log(out, {**tag, "event": "stopped before admission (STOP present)"}); die(5, "stop requested before the batch started")
    active = os.path.join(out, "active.json")
    stop = {"req": False}                                            # 1772: the handler exists BEFORE active.json is registered
    old = {sg: signal.signal(sg, lambda *_: stop.__setitem__("req", True)) for sg in (signal.SIGTERM, signal.SIGINT)}
    try:
        new_json(active, {"pid": os.getpid(), "startTime": starttime(os.getpid()), "mode": a.mode, "lo": a.lo, "hi": a.hi})
    except FileExistsError:
        for sg, h in old.items():
            signal.signal(sg, h)
        die(3, "another batch job is (or was, uncleanly) active: active.json exists - inspect, nothing is resumed automatically")
    try:
        if (a.lo, a.hi) not in batches(a.lo, a.hi) or a.hi - a.lo + 1 > BATCH:
            die(3, "invalid batch range")
        for k, f in (("manifest", B / "manifest.json"), (a.mode, B / f"{a.mode}-request.json")):
            if hashlib.sha256(f.read_bytes()).hexdigest() != PIN[k]:
                die(3, f"{f} is not the pinned {k} ({PIN[k][:12]}...)")
        if stop["req"] or stop_requested(out):
            die(5, "stop requested before admission")
        d, msha = MP.load_manifest(str(B / "manifest.json"), PIN["manifest"])
        busy = busy_reasons(Path("/proc/self/mountinfo").read_text(), all_procs(), os.getpid())
        if busy:
            die(3, f"another session / stage view is active: {busy[:6]}")
        adm = admit(d, msha, a.lo, a.hi, a.mode)
        new_json(os.path.join(out, f"admission-{a.lo:03d}-{a.hi:03d}-{a.mode}.json"), adm)
        log(out, {**tag, "event": "admitted", "capacity": adm["capacity"]})
        req = B / f"{a.mode}-request.json"
        p = guarded_launch(out, lambda: stop["req"], lambda: subprocess.Popen(
            ["bash", str(STAGE / "jobs/root-preservation.sh"), str(req), PIN[a.mode], str(B / "manifest.json"), PIN["manifest"],
             a.mode, f"{a.lo}-{a.hi}"], cwd=str(W), start_new_session=True))
        if p is None:
            die(5, "stop requested before the wrapper started (no production started)")
        log(out, {**tag, "event": "wrapper started", "pid": p.pid})
        forwarded = False
        while os.waitid(os.P_PID, p.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
            if (stop["req"] or stop_requested(out)) and not forwarded:   # retried until orchestrate exists or the wrapper ends
                hit = find_descendant(p.pid, is_orchestrate)
                if hit is not None:
                    signal.pidfd_send_signal(hit[0], signal.SIGTERM); os.close(hit[0]); forwarded = True
                    log(out, {**tag, "event": "stop forwarded to orchestrate"})
            time.sleep(0.5)
        rc = p.wait()
        log(out, {**tag, "event": "wrapper exited", "rc": rc})
        if rc != 0:
            die(rc if 0 < rc < 128 else 4, f"wrapper rc {rc}: stopping (parts and receipts preserved)")
        try:
            res = post_check(d, msha, a.lo, a.hi, a.mode, adm)
        except SystemExit as e:
            die(4, f"post-check failed after the wrapper ran (rc {e.code} remapped to 4)") if e.code != 4 else None
            raise
        except (MP.Refuse, MP.Fail, OSError) as e:
            die(4, f"post-check failed after the wrapper ran: {e}")
        log(out, {**tag, "event": "post-check passed", **res})
        print(json.dumps({**tag, "rc": 0, **res}))
        return 0
    except SystemExit as e:
        log(out, {**tag, "event": "stopped", "rc": e.code})
        raise
    finally:
        for sg, h in old.items():
            signal.signal(sg, h)
        with contextlib.suppress(OSError):
            os.unlink(active)


# ---- the outer driver (not queued) ----------------------------------------------------------------------------------------------
def is_batch_of(cmd):
    return len(cmd) >= 5 and cmd[3] == str(SCRIPT) and cmd[4] == "batch"


def forward_to_batch(out, root_pid):
    """-> True once SIGTERM was sent to the batch job that registered itself in active.json AND is our own pidfd-pinned descendant"""
    try:
        act = json.loads(Path(out, "active.json").read_text())
    except (OSError, ValueError):
        return False                                                 # not registered yet (still queued): retried by the poll loop
    hit = find_descendant(root_pid, is_batch_of)
    if hit is None:
        return False
    fd, pid = hit
    try:
        if pid == act.get("pid") and starttime(pid) == act.get("startTime"):
            signal.pidfd_send_signal(fd, signal.SIGTERM)
            return True
        return False
    except OSError:
        return False
    finally:
        os.close(fd)


def cmd_drive(a):
    plan = batches(a.start, a.stop)
    out = a.out
    if not os.path.isabs(out):
        die(3, "--out must be absolute")
    sha = file_sha(SCRIPT)
    if a.runner_sha256 and a.runner_sha256 != sha:
        die(3, "this runner is not the expected --runner-sha256")
    os.mkdir(out, 0o700)                                             # NEW only
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}"
    new_json(os.path.join(out, "stop.lock"), {"purpose": "orders STOP against the batch's pre-launch check"})
    new_json(os.path.join(out, "run.lock"), {"runId": run_id, "pid": os.getpid(), "startTime": starttime(os.getpid()), "runnerSha256": sha,
                                             "start": a.start, "stop": a.stop, "batches": plan})
    log(out, {"job": "driver", "event": "start", "runId": run_id, "batches": len(plan), "runnerSha256": sha})
    state = {"stop": False}

    def on_signal(signum, _f):
        if state["stop"]:
            return                                                   # once; never re-enter the flock from a nested handler
        state["stop"] = True
        write_stop(out, f"signal {signum}")
    old = {sg: signal.signal(sg, on_signal) for sg in (signal.SIGTERM, signal.SIGINT)}
    try:
        for lo, hi in plan:
            for mode in ("copy", "verify"):
                if state["stop"] or stop_requested(out):
                    log(out, {"job": "driver", "event": "stopped: no new queue job", "before": [lo, hi, mode]}); return 5
                name = f"rmp-r3-b{lo:03d}-{hi:03d}-{mode}-1773-{run_id}"
                c = subprocess.Popen(["bash", a.queue_cmd, name, QUEUE_MIB, "python3", "-I", "-B", str(SCRIPT), "batch", "--mode", mode,
                                      "--lo", str(lo), "--hi", str(hi), "--out", out, "--run-id", run_id, "--runner-sha256", sha],
                                     cwd=str(W), start_new_session=True)  # a terminal ^C reaches only this driver
                forwarded = False
                while c.poll() is None:
                    if state["stop"] and not forwarded:
                        forwarded = forward_to_batch(out, c.pid)     # retried every second until it lands
                        if forwarded:
                            log(out, {"job": "driver", "event": "stop forwarded to the batch job", "name": name})
                    time.sleep(1)
                rc = c.returncode
                log(out, {"job": "driver", "event": "queue job exited", "name": name, "rc": rc})
                if rc != 0:
                    return rc
        log(out, {"job": "driver", "event": "all batches done", "last": plan[-1]})
        return 0
    finally:
        for sg, h in old.items():
            signal.signal(sg, h)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    dr = sub.add_parser("drive"); dr.add_argument("--out", required=True)
    dr.add_argument("--start", type=int, default=FIRST); dr.add_argument("--stop", type=int, default=LAST)
    dr.add_argument("--runner-sha256"); dr.add_argument("--queue-cmd", default=QUEUE)          # --queue-cmd: tests only
    bt = sub.add_parser("batch"); bt.add_argument("--mode", choices=("copy", "verify"), required=True)
    bt.add_argument("--lo", type=int, required=True); bt.add_argument("--hi", type=int, required=True)
    bt.add_argument("--out", required=True); bt.add_argument("--run-id", required=True); bt.add_argument("--runner-sha256", required=True)
    a = ap.parse_args(argv)
    try:
        return cmd_drive(a) if a.cmd == "drive" else cmd_batch(a)
    except (MP.Refuse, MP.Fail) as e:
        print(f"## REFUSED: {e}", file=sys.stderr); return 3
    except (ValueError, FileExistsError) as e:                      # an invalid range, an existing --out or admission file
        print(f"## REFUSED: {e}", file=sys.stderr); return 3
    except OSError as e:
        print(f"## FAILED: {e}", file=sys.stderr); return 4


if __name__ == "__main__":
    sys.exit(main())
