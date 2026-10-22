"""Exercise queue overlap and exclusivity inside one guarded outer allocation."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

work = Path(__file__).resolve().parent
processes = []
with tempfile.TemporaryDirectory(prefix="queue-overlap-", dir=work) as directory:
    root = Path(directory)
    shutil.copy2(work / "claude-test-queue.py", root / "claude-test-queue.py")
    (root / "enclave").symlink_to(work / "enclave", target_is_directory=True)
    worker = root / "worker.py"
    worker.write_text(
        "import json,sys,time\n"
        "from pathlib import Path\n"
        "p=Path(sys.argv[1]); p.with_suffix('.start').write_text(str(time.monotonic()))\n"
        "time.sleep(float(sys.argv[2]))\n"
        "p.with_suffix('.end').write_text(str(time.monotonic()))\n"
    )

    def start(name, mib, seconds):
        log = (root / (name + ".log")).open("w")
        process = subprocess.Popen(
            [sys.executable, str(root / "claude-test-queue.py"),
             "--mib", str(mib), "--log", str(root / (name + ".guard.log")),
             "--", sys.executable, str(worker), str(root / name), str(seconds)],
            stdout=log, stderr=subprocess.STDOUT,
        )
        processes.append((process, log))
        return process

    def started(name, process):
        deadline = time.monotonic() + 70
        path = root / (name + ".start")
        while not path.exists():
            if process.poll() is not None:
                raise RuntimeError((root / (name + ".log")).read_text())
            if time.monotonic() > deadline:
                raise TimeoutError(name)
            time.sleep(0.05)

    try:
        large = start("large", 512, 6)
        started("large", large)
        small = start("small", 256, 9)
        started("small", small)
        assert not (root / "large.end").exists(), "Small job failed to overlap a running large job"
        other_small = start("other-small", 256, 0)
        assert other_small.wait(timeout=5) == 98, "More than one small allocation was admitted"
        assert not (root / "other-small.start").exists()
        next_large = start("next-large", 512, 2)
        for process in [large, small, next_large]:
            assert process.wait(timeout=75) == 0
        times = {
            name: {
                event: float((root / (name + "." + event)).read_text())
                for event in ["start", "end"]
            }
            for name in ["large", "small", "next-large"]
        }
        assert times["small"]["start"] < times["large"]["end"]
        assert times["next-large"]["start"] >= times["large"]["end"]
        assert times["next-large"]["start"] < times["small"]["end"]
        logs = {name: (root / (name + ".log")).read_text()
                for name in ["large", "small", "other-small", "next-large"]}
        assert "concurrentLargeReserve=1536MiB" in logs["small"]
        assert "required=18432MiB" in logs["small"]
        assert "concurrentSmall=256MiB" in logs["next-large"]
        assert "small allocation held" in logs["other-small"]
        result = {
            "passed": True, "times": times,
            "checks": [
                "One small job starts while a large job is running",
                "Concurrent small admission reserves the maximum 1536 MiB large budget",
                "A second small job is refused without starting",
                "Large jobs never overlap",
                "A replacement large job accounts for the still-running small job",
                "The 16 GiB host floor and no-swap scopes remain enabled",
            ],
            "logs": logs,
        }
        (work / "queue-overlap-verification.json").write_text(json.dumps(result, indent=2) + "\n")
        print("Queue overlap and exclusivity: all checks passed.")
    finally:
        for process, log in processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            log.close()
