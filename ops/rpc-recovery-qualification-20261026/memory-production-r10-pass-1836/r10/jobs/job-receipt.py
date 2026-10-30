#!/usr/bin/env python3
"""composite-mdbx-validation-stage/r10 final job receipt (prepared by Claude 1833; NOT run by Claude). r9's inline generator + review
1831 B1: snapshotsOk = the after-collection exit was 0 AND both status files are present, regular, complete (end=1), have EXACTLY the
expected keys and per-command codes (grep/pgrep 0|1, awk/sort 0) AND every evidence file is a regular file. Anything missing, malformed or
truncated is NOT ok. Exit 0 only if every final check is true.
    job-receipt.py RUN_DIR J_DIR RUNTIME_RC COLLECT_RC"""
import json, os, pathlib, stat, sys

RULES = {"before": {"peers.mounts": "gzgz", "peers.procs": "ggz"},
         "after": {"peers.mounts": "gzgz", "peers.procs": "ggz", "mounts.left": "g", "procs.left": "gg"}}
FILES = {"before": ["peers-before.txt"], "after": ["peers-after.txt", "mounts-left.txt", "processes-left.txt"]}


def regular(p):
    try:
        st = os.lstat(p)
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode)


def status_ok(J, mode):
    p = J / f"status-{mode}.txt"
    if not regular(p) or p.stat().st_size > 4096:
        return False
    try:
        lines = p.read_text().split("\n")
    except (OSError, UnicodeDecodeError):
        return False
    if lines[-1:] != [""] or lines[-2:-1] != ["end=1"]:
        return False                                                    # truncated or not ours
    kv = {}
    for l in lines[:-2]:
        k, sep, v = l.partition("=")
        if not sep or k in kv:
            return False
        kv[k] = v
    if set(kv) != set(RULES[mode]):
        return False
    for k, rule in RULES[mode].items():
        codes = kv[k].split(",")
        if len(codes) != len(rule) or not all(c.isdigit() for c in codes):
            return False
        if not all((r == "g" and c in ("0", "1")) or (r == "z" and c == "0") for r, c in zip(rule, codes)):
            return False
    return all(regular(J / f) for f in FILES[mode])


def text(p):
    return p.read_text() if regular(p) else None


def main(argv):
    O, J, rc, arc = pathlib.Path(argv[1]), pathlib.Path(argv[2]), int(argv[3]), int(argv[4])
    p = O / "session" / "receipt.json"
    try:
        r = json.loads(p.read_text()) if p.exists() else {}
        if not isinstance(r, dict):
            r = {}
    except (OSError, ValueError):
        r = {"outcome": "MALFORMED runtime receipt"}
    killed, termed = rc in (137, 128 + 9), rc == 124
    mem = r.get("memory") if isinstance(r.get("memory"), dict) else {}
    before, after, mounts, procs = (text(J / n) for n in ("peers-before.txt", "peers-after.txt", "mounts-left.txt", "processes-left.txt"))
    snap = arc == 0 and status_ok(J, "before") and status_ok(J, "after")
    checks = {"rc0": rc == 0, "clean": r.get("outcome") == "CLEAN", "cleanupComplete": r.get("cleanupComplete") is True,
              "snapshotsOk": snap, "peersUnchanged": snap and before is not None and before == after,
              "noMountLeft": snap and mounts == "", "noProcessLeft": snap and procs == ""}
    rec = {"format": "composite-production-memory-job-receipt/r10", "structurallyCleanRun": all(checks.values()), "checks": checks,
           "rc": rc, "collectRc": arc, "runtimeKilled": killed, "wrapperTerm": termed,
           "outcome": ("CLEANUP-INCOMPLETE (runtime killed by the wrapper)" if killed else r.get("outcome")),
           "reasons": (r.get("reasons") or [])[:8] if isinstance(r.get("reasons"), list) else None, "memoryPeaks": mem.get("peaks"),
           "softStop": mem.get("softStop"), "memoryDirty": mem.get("memoryDirty"), "mountsLeft": (mounts or "")[:4000],
           "processesLeft": (procs or "")[:4000],
           "meaning": "CLEAN = mdbx_chk structural check only; not chain/state/trie/canonical-root/RPC validation, not a production acceptance"}
    print(json.dumps(rec, indent=1, sort_keys=True, default=str))
    return 0 if rec["structurallyCleanRun"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
