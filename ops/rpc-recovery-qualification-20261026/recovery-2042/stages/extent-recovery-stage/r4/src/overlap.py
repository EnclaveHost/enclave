#!/usr/bin/env python3
"""extent-recovery-stage/r1 wrapper (PREPARED by Claude; NOT run by Claude). Read-only: validates a CANDIDATE extent map (the
unauthenticated reconstruction `candidate-extent-coverage.json`), pipes it to the C tool `ext4-extent-overlap` (libext2fs, opened
WITHOUT EXT2_FLAG_RW) and writes a bounded JSON report. Nothing here writes to the filesystem or the device.

  overlap.py --tool BIN --candidate FILE.json --device DEV [--crosscheck] [--max-output-bytes N] [--timeout SEC] [--out REPORT.json]

INTERPRETATION (carried into every report): an overlap = blocks the CURRENT bitmap marks allocated. That disproves "untouched, the
whole extent map is recoverable as-is", but it is NOT proof the bytes were overwritten (that needs reading and comparing the
actual bytes); and no overlap does NOT prove the bytes are intact (transient reuse after the deletion is a separate gate)."""
import hashlib, json, os, stat, subprocess, sys

FORMAT = "extent-overlap-report/r1"
EXTENT_KEYS = ["blocks", "logical", "physical", "unwritten"]
MAX_CANDIDATE_BYTES = 64 << 20
MAX_EXTENTS = 1_000_000
OUTPUT_CAP = 16 << 20
INTERPRETATION = [
    "overlap = blocks marked ALLOCATED in the CURRENT block bitmap of this read-only view",
    "any overlap disproves an untouched full recovery from this extent map as-is",
    "allocated now is NOT proof of overwritten bytes: that needs reading and comparing the actual bytes",
    "no overlap is NOT proof of intact bytes: transient reuse after the deletion (bitmap history) is a separate gate",
    "the extent map itself is an UNAUTHENTICATED reconstruction (its 'authentication' field is carried verbatim)"]


class Refused(Exception):
    pass


def read_nofollow(path, cap):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > cap:
            raise Refused(f"{path}: must be a regular file <= {cap} bytes")
        b = os.read(fd, cap + 1)
        if len(b) > cap:
            raise Refused(f"{path}: grew beyond {cap} bytes")
        return b
    finally:
        os.close(fd)


def _u(v):
    return type(v) is int and 0 <= v < (1 << 63)


def extents_of(doc):
    if not isinstance(doc, dict) or not isinstance(doc.get("extents"), list):
        raise Refused("candidate must be an object with an 'extents' list")
    ex = doc["extents"]
    if not 1 <= len(ex) <= MAX_EXTENTS:
        raise Refused(f"1..{MAX_EXTENTS} extents required")
    lines = []
    for i, e in enumerate(ex):
        if not isinstance(e, dict) or sorted(e) != EXTENT_KEYS or not all(_u(e[k]) for k in ("logical", "physical", "blocks")) \
                or type(e["unwritten"]) is not bool:
            raise Refused(f"extent {i}: exactly {EXTENT_KEYS}, non-negative integers and a boolean 'unwritten'")
        lines.append(f"{i} {e['logical']} {e['physical']} {e['blocks']} {int(e['unwritten'])}\n")
    return "".join(lines).encode()


def run(tool, device, stdin_bytes, crosscheck=False, max_output=OUTPUT_CAP, timeout=3600):
    argv = [tool] + (["--crosscheck"] if crosscheck else []) + ["--max-output-bytes", str(max_output), device]
    p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
    try:
        out, err = p.communicate(stdin_bytes, timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill(); p.communicate(); raise Refused(f"the tool exceeded {timeout} s")
    if len(out) > max_output + 4096:                                    # the tool caps itself; the summary line is extra
        raise Refused("the tool's output exceeded its own cap")
    return p.returncode, out.decode("utf-8", "replace"), err[-4096:].decode("utf-8", "replace")


def parse(text):
    head, overlaps, invalid, summary = [], [], [], None
    lines = text.splitlines()
    for n, l in enumerate(lines):
        f = l.split(" ")
        if l.startswith("# "):
            head.append(l[2:])
        elif f[0] in ("overlap", "invalid") and len(f) == 6 and all(x.isdigit() for x in f[1:]):
            rec = dict(zip(("index", "logical", "physical", "count" if f[0] == "overlap" else "blocks", "unwritten"), map(int, f[1:])))
            (overlaps if f[0] == "overlap" else invalid).append(rec)
        elif f[0] == "summary" and n == len(lines) - 1:
            summary = {k: int(v) for k, v in (x.split("=", 1) for x in f[1:])}
        else:
            raise Refused(f"unexpected tool output line {n + 1}")
    if summary is None:
        raise Refused("the tool produced no final summary line")
    return head, overlaps, invalid, summary


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--tool", required=True); ap.add_argument("--candidate", required=True); ap.add_argument("--device", required=True)
    ap.add_argument("--crosscheck", action="store_true"); ap.add_argument("--max-output-bytes", type=int, default=OUTPUT_CAP)
    ap.add_argument("--timeout", type=int, default=3600); ap.add_argument("--out")
    o = ap.parse_args(argv[1:])
    a = {"--tool": o.tool, "--candidate": o.candidate, "--device": o.device, **({"--out": o.out} if o.out else {})}
    try:
        if not 64 <= o.max_output_bytes <= OUTPUT_CAP or not 1 <= o.timeout <= 86400:
            raise Refused(f"--max-output-bytes 64..{OUTPUT_CAP}, --timeout 1..86400")
        raw = read_nofollow(a["--candidate"], MAX_CANDIDATE_BYTES)
        try:
            doc = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise Refused("candidate is not UTF-8 JSON")
        data = extents_of(doc)
        if "--out" in a and os.path.lexists(a["--out"]):
            raise Refused(f"{a['--out']} exists: never overwritten")
        rc, out, err = run(a["--tool"], a["--device"], data, o.crosscheck, o.max_output_bytes, o.timeout)
        if rc not in (0, 3):
            raise Refused(f"tool rc {rc}: {err.strip()[-500:]}")
        head, overlaps, invalid, summary = parse(out)
        if summary["extents"] != len(doc["extents"]):
            raise Refused("the tool did not read every extent")
        tool_sha = hashlib.sha256(read_nofollow(a["--tool"], 64 << 20)).hexdigest()
        report = {"format": FORMAT, "candidate": {"path": a["--candidate"], "sha256": hashlib.sha256(raw).hexdigest(),
                                                  "extents": len(doc["extents"]), "authentication": doc.get("authentication")},
                  "device": a["--device"], "tool": {"path": a["--tool"], "sha256": tool_sha}, "header": head, "summary": summary,
                  "complete": summary["truncated"] == 0, "overlaps": overlaps, "invalid": invalid, "toolRc": rc,
                  "interpretation": INTERPRETATION}
        text = json.dumps(report, indent=1) + "\n"
        if "--out" in a:
            fd = os.open(a["--out"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(text)
        else:
            sys.stdout.write(text)
        return rc
    except (Refused, OSError, ValueError) as e:
        print(f"REFUSED: {e}", file=sys.stderr); return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
