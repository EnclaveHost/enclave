#!/usr/bin/env python3
"""negative_r2.py - NEGATIVE CONTROL for root review r3: the reviewed r2 c2fx (ref/r2-reviewed/c2fx.r2.py, df5a7a88) signals a
process named by a pid file in a REPLACEMENT stage before refusing to delete that stage. Exit 0 = the defect is reproduced (the
r3 test test_replacement_stage_with_a_real_unrelated_identity_is_not_inspected is sensitive to it).
The victim is a harmless `sleep` this script starts in its OWN transient systemd-run scope. Run only through the shared queue."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.dont_write_bytecode = True
PKG = Path(__file__).resolve().parent.parent
sp = importlib.util.spec_from_file_location("c2fx_r2", PKG / "ref/r2-reviewed/c2fx.r2.py")
r2 = importlib.util.module_from_spec(sp)
sp.loader.exec_module(r2)


class NoDocker:
    def labels(self, *a):
        return None


def main():
    t = Path(tempfile.mkdtemp(prefix="c2fx-nc4-"))
    victim = None
    try:
        r = r2.Run(t / "runs", NoDocker(), run_id="nc4-replacement", scope=r2.queue_scope())
        r.term_wait, r.kill_wait = 3, 3
        r.begin()
        victim = subprocess.Popen(["systemd-run", "--user", "--scope", "--quiet", "-p", "MemoryMax=32M", "sleep", "120"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        mine = r2.Proc().cgroup("self")
        for _ in range(200):
            if r2.Proc().cgroup(victim.pid) not in (None, mine) and Path(f"/proc/{victim.pid}/exe").resolve().name == "sleep":
                break
            time.sleep(0.05)
        start, boot = r2.Proc().start(victim.pid), r2.Proc().boot_id()
        os.rename(r.stage, t / "ours-moved")
        (r.stage / "node/state").mkdir(parents=True)
        (r.stage / "node/state/indexd.pid").write_text(f"{victim.pid} {start} {boot}\n")
        rep = r.cleanup(pid_files=[r.stage / "node/state/indexd.pid"])
        time.sleep(0.2)
        killed = victim.poll() is not None
        out = {"r2": "ref/r2-reviewed/c2fx.r2.py", "victimOutsideScope": r2.Proc().cgroup(victim.pid) != mine if not killed else True,
               "victimKilled": killed, "pidFileOutcome": rep.get("indexdPidFiles"), "stage": rep.get("stage")}
        print(json.dumps(out, indent=1))
        print("NEGATIVE CONTROL", "REPRODUCED" if killed else "NOT REPRODUCED")
        return 0 if killed else 1
    finally:
        if victim is not None and victim.poll() is None:
            victim.kill()                     # the throwaway sleep this script started
        if victim is not None:
            victim.wait(5)
        shutil.rmtree(t, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
