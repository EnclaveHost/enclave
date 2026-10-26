#!/usr/bin/env python3
"""base-state-readonly-stage/r7 jobs/mount_identity.py (PREPARED by Claude 1735; NOT run by Claude). Standard library only.
Fail-closed identity check of the build-scratch mount, replacing r5/r6's `findmnt ... | tr -s ' '` string compare (root's actual r5
build: findmnt pads its last column with TWO trailing spaces; `tr -s` keeps one, so the exact string never matched and the job refused).

  mount_identity.py --target PATH --uuid U --source S --fstype F --majmin M
runs `findmnt -n -o UUID,SOURCE,FSTYPE,MAJ:MIN -T PATH` (PATH=/usr/bin:/bin, 10 s, read-only) and requires: rc 0, EXACTLY one
non-blank output line, EXACTLY 4 whitespace-separated fields, and each field equal to its expected value (compared one by one).
Anything else - missing, extra or mismatched field, several lines, no output, findmnt error - refuses with exit 9. Exit 0 = match."""
import argparse, json, subprocess, sys

FIELDS = ("uuid", "source", "fstype", "majmin")


def check(text, want):
    """-> (ok, reason). `want` = dict over FIELDS. Padding/whitespace between and after columns is irrelevant; nothing else is."""
    lines = [l for l in text.splitlines() if l.strip()]
    if len(lines) != 1:
        return False, f"expected exactly 1 findmnt line, got {len(lines)}"
    got = lines[0].split()
    if len(got) != len(FIELDS):
        return False, f"expected exactly {len(FIELDS)} fields, got {len(got)}: {got!r}"
    for name, value in zip(FIELDS, got):
        if value != want[name]:
            return False, f"{name} {value!r} != pinned {want[name]!r}"
    return True, "match " + json.dumps(dict(zip(FIELDS, got)), sort_keys=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description="fail-closed findmnt identity check")
    ap.add_argument("--target", required=True)
    for f in FIELDS:
        ap.add_argument(f"--{f}", required=True)
    a = ap.parse_args(argv)
    want = {f: getattr(a, f) for f in FIELDS}
    if any(not v or any(c.isspace() for c in v) for v in want.values()):
        print("REFUSED: empty or whitespace-containing pinned value", file=sys.stderr); return 9
    try:
        p = subprocess.run(["findmnt", "-n", "-o", "UUID,SOURCE,FSTYPE,MAJ:MIN", "-T", a.target], capture_output=True, text=True,
                           timeout=10, env={"PATH": "/usr/bin:/bin"}, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"REFUSED: findmnt failed: {e}", file=sys.stderr); return 9
    if p.returncode != 0:
        print(f"REFUSED: findmnt rc {p.returncode}: {p.stderr.strip()[:200]}", file=sys.stderr); return 9
    ok, why = check(p.stdout, want)
    print(("OK: " if ok else "REFUSED: ") + why, file=sys.stdout if ok else sys.stderr)
    return 0 if ok else 9


if __name__ == "__main__":
    sys.exit(main())
