#!/usr/bin/env python3
"""fake_docker_rm.py - MOCK docker for test/test_rehearsal.py: runs the reviewed storage-enclave-fixture test/fake_docker.py
(pinned, read-only, unchanged) and adds `docker run --rm`. A container that ran with --rm and exited is gone afterwards,
unless $FAKEDOCKER_FAULT contains "rm-ignored" (the daemon left it behind). It never talks to a docker daemon."""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

WORK = next(p for p in Path(__file__).resolve().parents if p.name == "work")
FAKE = WORK / "claude-resumed-20261022/storage-enclave-fixture/test/fake_docker.py"
assert hashlib.sha256(FAKE.read_bytes()).hexdigest() == "5573acf72bcb04ad70a89ff3f219080780dc9f001fba4f9dd02bc52e3e2213ea", "fixture fake_docker.py pin"
a = sys.argv[1:]
r = subprocess.run([sys.executable, "-B", str(FAKE), *a], capture_output=True, text=True)
if a[:1] == ["run"] and "--rm" in a and r.returncode == 0 and "rm-ignored" not in os.environ.get("FAKEDOCKER_FAULT", ""):
    name = a[a.index("--name") + 1]
    S = os.environ["FAKEDOCKER_STATE"]
    st = json.load(open(S))
    st["containers"].pop(name, None)
    json.dump(st, open(S, "w"))
sys.stdout.write(r.stdout)
sys.stderr.write(r.stderr)
sys.exit(r.returncode)
