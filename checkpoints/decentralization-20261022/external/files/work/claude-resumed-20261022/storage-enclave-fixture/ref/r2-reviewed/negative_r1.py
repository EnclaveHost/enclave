#!/usr/bin/env python3
"""negative_r1.py - NEGATIVE CONTROLS: the reviewed r1 c2fx (ref/r1-reviewed/c2fx.r1.py, b5ae3e88, byte-exact reconstruction)
on the scenarios of root review R1/R2. Each must REPRODUCE the defect (exit 0 = every defect reproduced, i.e. the new tests
are sensitive to it). Run only through the shared queue: NC3 uses this job's real scope and its own throwaway processes.
  NC1 root's mkdir race: r1 deletes the other run's directory and reports certain
  NC2 replacement directory at the stage path: r1 deletes it
  NC3 grandchild (executable outside the stage) still writing in the stage: r1 reports certain and deletes the stage
      while the writer still runs"""
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
PKG = Path(__file__).resolve().parent.parent
sp = importlib.util.spec_from_file_location("c2fx_r1", PKG / "ref/r1-reviewed/c2fx.r1.py")
r1 = importlib.util.module_from_spec(sp)
sp.loader.exec_module(r1)


class NoDocker:
    def labels(self, *a):
        return None


def nc1(t):
    r = r1.Run(t / "runs", NoDocker(), run_id="nc1-race")
    orig = os.mkdir
    def race(p, *a, **k):
        if Path(p) == r.stage:
            orig(p, *a, **k); (r.stage / "other-run.txt").write_text("x"); raise FileExistsError("race")
        return orig(p, *a, **k)
    with patch("os.mkdir", race):
        try:
            r.begin()
        except FileExistsError:
            pass
    rep = r.cleanup()
    return {"reproduced": not (r.stage / "other-run.txt").exists() and rep["certain"], "stage": rep.get("stage")}


def nc2(t):
    r = r1.Run(t / "runs2", NoDocker(), run_id="nc2-replace")
    r.begin()
    os.rename(r.stage, t / "moved")
    r.stage.mkdir(); (r.stage / "other-run.txt").write_text("x")
    rep = r.cleanup()
    return {"reproduced": not (r.stage / "other-run.txt").exists(), "stage": rep.get("stage")}


def nc3(t):
    rel = Path("/proc/self/cgroup").read_text().strip().split("::", 1)[1]
    r = r1.Run(t / "runs3", NoDocker(), run_id="nc3-grandchild", cgroup="/sys/fs/cgroup" + rel)
    r.term_wait, r.kill_wait = 3, 3
    r.begin()
    sh = subprocess.Popen(["sh", "-c", '( while :; do echo x >> "$1/held.log" 2>/dev/null; sleep 0.05; done ) & echo $! > "$1/gc.pid"; exit 0', "_", str(r.stage)])
    sh.wait(10)
    for _ in range(100):
        if (r.stage / "gc.pid").exists() and (r.stage / "gc.pid").read_text().strip():
            break
        time.sleep(0.05)
    gc = int((r.stage / "gc.pid").read_text())
    time.sleep(0.3)
    rep = r.cleanup()
    still = Path(f"/proc/{gc}").exists()
    try:
        os.kill(gc, signal.SIGKILL)                    # the throwaway writer this script started
    except ProcessLookupError:
        pass
    return {"reproduced": rep["certain"] and still and not r.stage.exists(), "certain": rep["certain"], "writerStillRunning": still,
            "cgroupMatches": rep["indexd"]["cgroup"]}


def main():
    t = Path(tempfile.mkdtemp(prefix="c2fx-nc-"))
    try:
        out = {"r1": "ref/r1-reviewed/c2fx.r1.py", "NC1": nc1(t), "NC2": nc2(t), "NC3": nc3(t)}
    finally:
        shutil.rmtree(t, ignore_errors=True)
    print(json.dumps(out, indent=1))
    ok = all(out[k]["reproduced"] for k in ("NC1", "NC2", "NC3"))
    print("NEGATIVE CONTROLS", "ALL REPRODUCED" if ok else "NOT REPRODUCED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
