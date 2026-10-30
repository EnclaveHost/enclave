#!/usr/bin/env python3
"""Gate: accept ONLY a complete, passing guest M10 run 2, bound by root-supplied sha256 pins of its collected receipts.
  check-run2-receipt.py RECEIPT_JSON RUN_OUT RUN_RC RECEIPT_SHA OUT_SHA RC_SHA
Refuses (exit 1, reason printed) on: any missing file; any pin mismatch; malformed JSON; rc != 0; attempt != 2;
systemdRunExit != 0; pass != true; the receipt's outSha256 != the given out; the repair-stage manifest != 1864c852;
aggregate line not exactly '## aggregate rc=0'; ignoredTotal != 0; testResultLines != 8 (6 phases + 2 controls);
any phase OK line missing; REBUILT lines != the 5 builds (engine, node, cli, control-engine, control-node); either control not
'failed exactly as expected' with EXACTLY its expected set; any INVALID / missing-test / unexpected-control line; guard
lines not exit=0. A unit Result=success alone is never accepted."""
import hashlib, json, re, sys
REPAIR_MANIFEST = "1864c8526dd9487d5a07a12d311f8d887214fe85eed66eb9d9d8535e126b6d29"
PHASES = ["engine", "node", "node-seq", "node-safedb", "node-derivation", "cli"]
REBUILT = ["engine", "node", "cli", "control-engine", "control-node"]
CONTROLS = {"control-engine": "precondition_refuses_replayed_snapshot_labels_above_n precondition_refuses_wrong_number_wrong_hash_and_rpc_claimed_hash",
            "control-node": "a_failing_reset_is_fatal real_redb_wipe_removes_snapshot_entries_persistently"}
FORBIDDEN = ["## INVALID", "M10 test missing or not ok", "DID NOT FAIL AS EXPECTED", "FAILED (rc=", "control did not run"]
def refuse(why): print(f"[REFUSE] run-2 receipt: {why}"); sys.exit(1)
def main(a):
    if len(a) != 6: refuse("usage: RECEIPT_JSON RUN_OUT RUN_RC RECEIPT_SHA OUT_SHA RC_SHA")
    files, pins = a[:3], a[3:]
    raw = []
    for f, p in zip(files, pins):
        if not re.fullmatch(r"[0-9a-f]{64}", p): refuse(f"pin for {f} is not a sha256")
        try: b = open(f, "rb").read()
        except OSError as e: refuse(f"missing {f}: {e}")
        if hashlib.sha256(b).hexdigest() != p: refuse(f"{f} does not match its pin {p[:12]}")
        raw.append(b)
    jb, ob, rb = raw
    if rb.strip() != b"0": refuse(f"run-2 rc is {rb.strip()!r}, not 0")
    try: r = json.loads(jb)
    except ValueError as e: refuse(f"malformed receipt JSON: {e}")
    if not isinstance(r, dict): refuse("receipt is not an object")
    want = {"attempt": 2, "systemdRunExit": 0, "pass": True, "aggregateLine": "## aggregate rc=0", "ignoredTotal": 0,
            "testResultLines": 8, "stageManifestSha256": REPAIR_MANIFEST, "outSha256": hashlib.sha256(ob).hexdigest()}
    for k, v in want.items():
        if r.get(k) != v or type(r.get(k)) is not type(v): refuse(f"receipt {k} = {r.get(k)!r}, required {v!r}")
    g = r.get("guardLines")
    if not isinstance(g, list) or not any(x.startswith("[memory-guard] exit=0 ") for x in g) or not any(x.startswith("[disk-guard] exit=0 ") for x in g):
        refuse("guard lines are not both exit=0")
    try: out = ob.decode()
    except UnicodeDecodeError: refuse("run-2.out is not UTF-8")
    lines = out.splitlines()
    for bad in FORBIDDEN:
        if any(bad in l for l in lines): refuse(f"run-2.out contains '{bad}'")
    if lines.count("## aggregate rc=0") != 1 or any(l.startswith("## aggregate rc=") and l != "## aggregate rc=0" for l in lines): refuse("aggregate line")
    if not any(l.startswith("## GUEST run 2 /srv/m10-guest-validation/runs/run-2: repair stage /srv/m10-guest-validation/stage-import-recovery,") for l in lines): refuse("run-2 header (repair stage) missing")
    if not any(l.startswith("## GUEST: reused cargo home satisfies every locked dependency offline:") and l.endswith("fsck True") for l in lines): refuse("offline dependency/fsck line missing")
    for ph in PHASES:
        if lines.count(f"## {ph} OK") != 1: refuse(f"phase {ph} not OK exactly once")
    rb_ = [l for l in lines if re.fullmatch(r"## ([a-z-]+): REBUILT \S+ sha256 [0-9a-f]{64}", l)]
    if sorted(re.match(r"## ([a-z-]+):", l).group(1) for l in rb_) != sorted(REBUILT): refuse(f"REBUILT builds {rb_}")
    sha = {re.match(r"## ([a-z-]+):", l).group(1): l.split()[-1] for l in rb_}
    if sha["control-engine"] == sha["engine"] or sha["control-node"] == sha["node"]: refuse("a control binary equals its patched binary")
    for c, s in CONTROLS.items():
        if lines.count(f"## {c} failed exactly as expected") != 1: refuse(f"{c} did not fail exactly as expected")
        fl = [l for l in lines if l.startswith(f"## {c} rc=")]
        if len(fl) != 1: refuse(f"{c} result line missing")
        m = re.fullmatch(rf"## {c} rc=(\d+) failing: (.*)", fl[0])
        if not m or m.group(1) == "0" or m.group(2).strip() != s: refuse(f"{c} failing set {fl[0]!r}")
    print(json.dumps({"accepted": True, "receiptSha256": pins[0], "outSha256": pins[1], "rcSha256": pins[2], "repairManifest": REPAIR_MANIFEST,
                      "rebuilt": sha}, indent=1))
if __name__ == "__main__": main(sys.argv[1:])
