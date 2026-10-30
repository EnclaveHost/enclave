#!/usr/bin/env python3
"""jobs/root-state-build-admission-1804.py (prepared by Claude 1804; NOT run by Claude). Stdlib + the pinned runner 1773's own code.

ONE fail-closed ADMISSION check, then os.execv of the UNCHANGED base-state-readonly-stage/r7 jobs/build.sh (which repeats its own
checks: stage SUMS, guard-test receipt, /vm mount identity, disk_guard 64 GiB start / 40 GiB floor / 20 GiB scratch / 7500 s).
Root ONLY, explicitly, in the 4096 MiB main lane (exclusive with every >= 512 MiB queue job, so no preservation copy/verify runs
during the build) and inside `unshare -Urn`:
    bash jobs/q-exit-status.sh bsro-r7-build-1804 4096 unshare -Urn python3 -I -B jobs/root-state-build-admission-1804.py
Never launched by the copy driver. Refuses (rc 3, nothing started; a refusal record is still written) unless ALL of:
  1. r7: SHA256SUMS = 7d4ccc8f..., every listed file re-hashed, jobs/build.sh = 4d28e87b...
  2. lane: cgroup v2 memory.max = 4096 MiB exactly; MemAvailable >= 16 GiB floor + 4096 + 256 MiB
  3. isolation: a user namespace (uid_map "0 <non-zero> ...") with no network route (unshare -Urn)
  4. capacity, by runner 1773's OWN metadata logic (pinned bytes 5c33f6e2...; r3 SUMS checked by its verify_stage; manifest
     f94807f7...; Targets = owned dirs + MAJ:MIN + findmnt UUID + not USB; inventory = no foreign files; part_state = r3 record rules:
     records + lstat identity only, NEVER part bytes). remaining[target] = the exact manifest length of EVERY part not committed
     (the FULL remaining production allocation, partials counted in full), then:
       vm   : free >= remaining_vm   + floorBytes(40 GiB) + 24 GiB build reserve (20 GiB scratch cap + 4 GiB cushion for the guard's
              15 s sampling overshoot; the scratch is KEPT after the build, so it is permanent until root removes it)
       root : free >= remaining_root + floorBytes(40 GiB) + 8 GiB native reservation (runner EXTERNAL) + 2 GiB final-copy allowance
              (r7 copies the two release binaries 0555 plus logs into its runs/ dir on this filesystem)
     and the build scratch base (/vm/enclave-volumes) is on the vm target's filesystem, r7/runs on the root target's.
"""
import hashlib, json, os, sys, time, types

W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
R7 = W + "/base-state-readonly-stage/r7"
R7_SUMS = "7d4ccc8f873c435f6e1fd5577e8f6d40e833479605c79701fe742dfcb00e0056"
BUILD_SH = "4d28e87b43206a84fa09fd140b0665f6891f57a2d1713dc47473f53016bfd89b"
RUNNER = W + "/jobs/root-multipart-batches-1773.py"
RUNNER_SHA = "5c33f6e24d0b880d47521c08a001c6b8d11af18cfcc044c411ef09a889ad410a"
SCRATCH_PARENT = "/vm/enclave-volumes"                     # build.sh BASE = /vm/enclave-volumes/rpc-recovery-validation-build
GIB, MIB = 1 << 30, 1 << 20
BUILD_RESERVE, FINAL_COPY_ALLOWANCE = 24 * GIB, 2 * GIB
LANE_MIB, FLOOR_MIB, HEADROOM_MIB = 4096, 16384, 256


class Refused(Exception):
    pass


def refuse(m):
    raise Refused(m)


def read_all(path, cap):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        out = b""
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                return out
            out += b
            if len(out) > cap:
                refuse(f"{path}: larger than {cap} bytes")
    finally:
        os.close(fd)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def check_r7():
    raw = read_all(R7 + "/SHA256SUMS", 1 << 20)
    if sha(raw) != R7_SUMS:
        refuse("base-state-readonly-stage/r7 SHA256SUMS is not the frozen one")
    for line in raw.decode().splitlines():
        h, _, name = line.partition("  ")
        if not name or os.path.isabs(name) or ".." in name.split("/") or sha(read_all(os.path.join(R7, name), 64 << 20)) != h:
            refuse(f"r7 {name or line[:60]} differs from its SHA256SUMS")
    if sha(read_all(R7 + "/jobs/build.sh", 1 << 20)) != BUILD_SH:
        refuse("r7 jobs/build.sh is not the reviewed one")


def check_lane_and_isolation():
    with open("/proc/self/cgroup") as f:
        rel = [l[3:] for l in f.read().splitlines() if l.startswith("0::")]
    if len(rel) != 1:
        refuse("not a single cgroup v2 hierarchy")
    with open("/sys/fs/cgroup" + rel[0] + "/memory.max") as f:
        mm = f.read().strip()
    if mm != str(LANE_MIB * MIB):
        refuse(f"memory.max {mm!r} is not the 4096 MiB main lane (run through jobs/q-exit-status.sh ... 4096)")
    with open("/proc/meminfo") as f:
        avail = [int(l.split()[1]) // 1024 for l in f if l.startswith("MemAvailable:")]
    if len(avail) != 1 or avail[0] < FLOOR_MIB + LANE_MIB + HEADROOM_MIB:
        refuse(f"MemAvailable {avail} MiB < floor {FLOOR_MIB} + lane {LANE_MIB} + {HEADROOM_MIB}")
    with open("/proc/self/uid_map") as f:
        m = f.read().split()
    if len(m) < 3 or m[0] != "0" or m[1] == "0":
        refuse("not inside `unshare -Urn` (user namespace mapping root to the owner)")
    with open("/proc/self/net/route") as f:
        if len(f.read().splitlines()) > 1:
            refuse("a network route exists: run inside `unshare -Urn`")
    return {"memoryMaxMiB": LANE_MIB, "memAvailableMiB": avail[0]}


def load_runner():
    raw = read_all(RUNNER, 4 << 20)
    if sha(raw) != RUNNER_SHA:
        refuse("runner 1773 is not the pinned file")
    mod = types.ModuleType("runner1773"); mod.__file__ = RUNNER
    exec(compile(raw, RUNNER, "exec"), mod.__dict__)        # module level only: imports the r3 core; its main() is not run
    return mod


def capacity(R):
    R.verify_stage()                                       # r3 SUMS (the runner's own check)
    d, msha = R.MP.load_manifest(str(R.B / "manifest.json"), R.PIN["manifest"])
    tg = R.Targets(d, True)
    try:
        cache, remaining, committed = {}, {n: 0 for n in tg.fd}, 0
        inv = {}
        for name, fd in tg.fd.items():
            per, foreign, _s = R.inventory(fd, d, name)
            if foreign:
                refuse(f"target {name}: files that are not ours: {foreign[:8]}")
            inv[name] = per
        for p in d["parts"]:
            names = inv[p["target"]].get(p["index"], [])
            st = R.part_state(d, msha, p, tg.fd[p["target"]], cache) if names else {"committed": False}
            if st["committed"]:
                committed += 1
            else:
                remaining[p["target"]] += p["length"]
        devs = {name: os.fstat(fd).st_dev for name, fd in tg.fd.items()}
        if os.stat(SCRATCH_PARENT).st_dev != devs.get("vm") or os.stat(R7 + "/runs").st_dev != devs.get("root"):
            refuse("the build scratch is not on the vm target's filesystem or r7/runs not on the root target's")
        extra = {"vm": BUILD_RESERVE, "root": R.EXTERNAL.get("root", 0) + FINAL_COPY_ALLOWANCE}
        out = {}
        for name, fd in tg.fd.items():
            v = os.statvfs(fd); free = v.f_bavail * v.f_frsize
            need = remaining[name] + d["targets"][name]["floorBytes"] + extra[name]
            out[name] = {"freeBytes": free, "remainingLogicalBytes": remaining[name], "floorBytes": d["targets"][name]["floorBytes"],
                         "reservationBytes": extra[name], "neededBytes": need, "marginBytes": free - need}
        bad = [n for n, c in out.items() if c["marginBytes"] < 0]
        if bad:
            refuse(f"capacity short on {bad}: {json.dumps({n: out[n] for n in bad})}")
        return {"manifestSha256": msha, "partsCommitted": committed, "parts": len(d["parts"]), "targets": out}
    finally:
        tg.close()


def main():
    rec = {"format": "state-build-admission/1804", "atEpoch": time.time(), "pid": os.getpid(),
           "exec": ["/usr/bin/bash", R7 + "/jobs/build.sh"]}
    try:
        check_r7(); rec["r7"] = {"sums": R7_SUMS, "buildSh": BUILD_SH}
        rec["lane"] = check_lane_and_isolation()
        rec["capacity"] = capacity(load_runner())
    except (Refused, OSError, ValueError, KeyError, SystemExit) as e:   # the runner's die() raises SystemExit
        rec["refused"] = f"{type(e).__name__}: {e}"[:800]
    name = f"{W}/logs/state-build-admission-1804-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{os.getpid()}.json"
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(rec, indent=1, sort_keys=True, default=str) + "\n")
    print(json.dumps({"admission": "REFUSED" if "refused" in rec else "ADMITTED", "record": name, **({"reason": rec["refused"]} if "refused" in rec else {})}), flush=True)
    if "refused" in rec:
        return 3
    os.execv("/usr/bin/bash", rec["exec"])                 # the unchanged r7 build (it re-checks everything it owns)


if __name__ == "__main__":
    sys.exit(main())
