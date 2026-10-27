#!/usr/bin/env python3
"""compact-header-extraction-stage/r2 coordination check (PREPARED by Claude 1881/1892; NOT run by Claude). Read-only; standard library.
r2 (review 1885 B1; root 1892): REQUIRED before BOTH the E2E tests and production, and before any fixture build or mount: ALL 265 parts
committed AND independently verified (the pinned bsro r12 `live_completion`, = the 1773 runner + r3 core on the pinned manifest), NO
multipart driver/batch/orchestrate/overlay process and no stage view mounted. There is NO exception (no driver pause, no override).

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
BSRO_GATE = (W + "/base-state-readonly-stage/r12/jobs/bsro_gate.py", "0641637ab6fa4bb007b7d97f4b1d1d3388b7815010f7b856e2f304b9cbb07dc4")


def completion_fingerprint():
    """the pinned bsro r12 all-265 gate (completed + independently verified, nothing stale/unconfirmed/invalid/failed, 0 remaining)"""
    import types
    with open(BSRO_GATE[0], "rb") as f:
        raw = f.read()
    if hashlib.sha256(raw).hexdigest() != BSRO_GATE[1]:
        raise RuntimeError("bsro r12 bsro_gate.py is not the pinned file")
    G = types.ModuleType("bsro_gate_r12"); G.__file__ = BSRO_GATE[0]
    exec(compile(raw, BSRO_GATE[0], "exec"), G.__dict__)
    return G.live_completion()


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
    try:
        out["completionFingerprint"] = completion_fingerprint()
    except Exception as e:                                              # noqa: BLE001 - any failure = not complete
        out["completionFingerprint"], out["completionError"] = None, f"{type(e).__name__}: {e}"[:300]
    out["refused"] = [*(["busy"] if busy else []), *(["root floor"] if out["rootFreeBytes"] is None or out["rootFreeBytes"] < out["rootNeededBytes"] else []),
                      *(["not all 265 parts committed and verified"] if out["completionFingerprint"] is None or any(remaining.values()) else [])]
    print(json.dumps(out, sort_keys=True))
    return 3 if out["refused"] else 0


if __name__ == "__main__":
    sys.exit(main())
