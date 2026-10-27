#!/usr/bin/env python3
"""compact-header-extraction-stage/r1 coordination check (PREPARED by Claude 1881; NOT run by Claude). Read-only; standard library.

Prints {"vmReserveBytes", "vmFloorBytes", "rootNeededBytes", "rootFreeBytes", ...} for jobs/root-extract.sh and exits 3 when the
extraction must not start:
  - any multipart batch driver/batch, orchestrate.py or overlay_session.py runs, or a stage view is mounted (the reviewed 1773
    runner's busy_reasons, plus its drivers: a driver between batches would otherwise start a batch that then refuses on our view);
  - root free < remaining root multipart reservation + max(40 GiB, manifest floor) + 8 GiB.
The remaining reservations are the 1773 runner's own rules (part_state per part on the pinned manifest: every not-committed part's
exact manifest length per target); the runner and its r3 core are sha-verified before import. Nothing is written."""
import hashlib, importlib.util, json, os, sys

W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
RUNNER = W + "/jobs/root-multipart-batches-1773.py"
RUNNER_SHA = "5c33f6e24d0b880d47521c08a001c6b8d11af18cfcc044c411ef09a889ad410a"
FLOOR, ROOT_EXTRA = 40 << 30, 8 << 30


def coordination_reasons(procs, me):
    """multipart drivers / batches (1764 or 1773) of anyone but us"""
    return [f"pid {pid}: {' '.join(cmd[:5])}" for pid, cmd in procs
            if pid != me and any(os.path.basename(c).startswith("root-multipart-batches-") for c in cmd[:4])]


def main():
    with open(RUNNER, "rb") as f:
        if hashlib.sha256(f.read()).hexdigest() != RUNNER_SHA:
            print("REFUSED: the 1773 runner is not the pinned file", file=sys.stderr); return 3
    spec = importlib.util.spec_from_file_location("runner1773", RUNNER)
    R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)        # verifies the r3 SUMS before importing its core
    procs = R.all_procs()
    with open("/proc/self/mountinfo") as f:
        busy = R.busy_reasons(f.read(), procs, os.getpid()) + coordination_reasons(procs, os.getpid())
    mpath = R.B / "manifest.json"
    raw = mpath.read_bytes()
    msha = hashlib.sha256(raw).hexdigest()
    if msha != R.PIN["manifest"]:
        print("REFUSED: the multipart manifest is not the pinned one", file=sys.stderr); return 3
    d = json.loads(raw)
    tg = R.Targets(d)
    try:
        cache, remaining, free = {}, {n: 0 for n in tg.fd}, {n: R.free_bytes(fd) for n, fd in tg.fd.items()}
        for p in d["parts"]:
            if not R.part_state(d, msha, p, tg.fd[p["target"]], cache)["committed"]:
                remaining[p["target"]] += p["length"]
    finally:
        tg.close()
    floor = {n: max(FLOOR, d["targets"][n]["floorBytes"]) for n in remaining}
    out = {"busy": busy, "remainingBytes": remaining, "freeBytes": free, "floorBytes": floor,
           "vmReserveBytes": remaining.get("vm", 0), "vmFloorBytes": floor.get("vm", FLOOR),
           "rootNeededBytes": remaining.get("root", 0) + floor.get("root", FLOOR) + ROOT_EXTRA}
    out["rootFreeBytes"] = free.get("root")
    out["refused"] = [*(["busy"] if busy else []), *(["root floor"] if out["rootFreeBytes"] is None or out["rootFreeBytes"] < out["rootNeededBytes"] else [])]
    print(json.dumps(out, sort_keys=True))
    return 3 if out["refused"] else 0


if __name__ == "__main__":
    sys.exit(main())
