#!/usr/bin/env python3
"""r5 test wrapper: runs jobs/disk_guard.py main() with SYNTHETIC providers (never fills a disk). argv: GUARD_PY CONFIG_JSON guard-args...
CONFIG: {"mountinfo": path to a synthetic mountinfo, "free": [GiB per call; the last value repeats]} (both optional)."""
import importlib.util, json, sys

spec = importlib.util.spec_from_file_location("disk_guard", sys.argv[1])
G = importlib.util.module_from_spec(spec); spec.loader.exec_module(G)
cfg = json.loads(sys.argv[2])
if "mountinfo" in cfg:
    G.MOUNTINFO = cfg["mountinfo"]
if "free" in cfg:
    seq = list(cfg["free"])
    G.free_bytes = lambda _p: int((seq.pop(0) if len(seq) > 1 else seq[0]) * G.GIB)
sys.exit(G.main(sys.argv[3:]))
