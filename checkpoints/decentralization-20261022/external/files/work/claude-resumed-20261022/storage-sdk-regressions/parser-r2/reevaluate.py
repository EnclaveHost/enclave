#!/usr/bin/env python3
"""parser-r2 re-evaluation of an EXISTING, TERMINAL sdk_regression_runner run. Offline and read-only: no test, harness,
driver, database or Docker is run. NOTHING here is a test re-run.
  reevaluate.py --run-dir <storage-sdk-regressions/runs/<id>-results> --config <config.json> --out <new file outside the run dir>
Refuses (exit 2):
  - when the run is not terminal (no summary.json; the runner writes it last, after cleanup);
  - when config.json is not the root-reviewed pin;
  - when --out exists or lies inside the run directory.
Per configured group it keeps the ORIGINAL runner record (verdict, real return code, harness exit) unchanged, and adds a
SEPARATE corrected verdict from libtest_r2:
  - NOT_RUN stays NOT_RUN; a group with no complete result (no GROUP-RESULT line) is INCOMPLETE;
  - any non-zero real return code or harness exit stays FAIL, whatever the parser says;
  - PASS needs rc 0, harness 0, GROUP-RESULT driver=0 consistent with the rc, and a strict libtest_r2 parse with every
    configured case `ok`;
  - the raw files are hashed into the output, and the input files are never written.
Exit: 0 every group corrected-PASS | 1 otherwise | 2 refused."""
import argparse, hashlib, json, os, pathlib, re, sys
H = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(H)); import libtest_r2  # noqa: E402

CONFIG_SHA = "243bf3c2457034ad304160f02b57cab07cee8e2a3e75871632a195a21ca974a3"
GROUP_RESULT = re.compile(r"^GROUP-RESULT driver=(\d+) harness=(\d+)$", re.M)
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


def refuse(msg): print(json.dumps({"refused": msg})); sys.exit(2)


def evaluate_group(run_dir, g, orig):
    rec = {"original": {k: orig.get(k) for k in ("verdict", "groupReturnCode", "harnessExit", "reason")} if orig else None, "inputs": {}}
    if orig is None: rec.update(corrected="INCOMPLETE", reasons=["no original runner record for this group"]); return rec
    if orig.get("verdict") == "NOT_RUN": rec.update(corrected="NOT_RUN", reasons=[orig.get("reason", "")]); return rec
    out, log = run_dir / f"{g['id']}.out", run_dir / g["id"] / "driver.log"
    for p in (out, log):
        if p.is_file() and not p.is_symlink(): rec["inputs"][str(p.relative_to(run_dir))] = sha(p)
    gr = GROUP_RESULT.findall(out.read_text(errors="replace")) if out.is_file() else []
    reasons = []
    rc, hx = orig.get("groupReturnCode"), orig.get("harnessExit")
    if len(gr) != 1: rec.update(corrected="INCOMPLETE", reasons=[f"{len(gr)} GROUP-RESULT lines in {out.name} (need exactly 1): the group's full result is not present"]); return rec
    d_rc, h_rc = int(gr[0][0]), int(gr[0][1])
    if rc != 0: reasons.append(f"real group return code {rc!r} (not 0)")
    if d_rc != rc: reasons.append(f"GROUP-RESULT driver={d_rc} disagrees with the recorded return code {rc!r}")
    if h_rc != 0 or str(hx) != "0": reasons.append(f"harness exit {h_rc} (recorded {hx!r})")
    if not log.is_file(): reasons.append("driver.log missing"); parsed = None
    else:
        parsed = libtest_r2.parse(log.read_text(errors="replace"), g["cases"])
        if not parsed["ok"]: reasons += [f"libtest_r2: {e}" for e in parsed["errors"]] or ["libtest_r2: not every case ok"]
    rec["libtest_r2"] = parsed
    rec["corrected"] = "PASS" if not reasons else "FAIL"; rec["reasons"] = reasons
    return rec


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--run-dir", required=True); ap.add_argument("--config", required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    run_dir = pathlib.Path(a.run_dir).resolve(); out = pathlib.Path(a.out).resolve()
    if not (run_dir / "summary.json").is_file(): refuse(f"{run_dir} has no summary.json: the run is not terminal (or not a runner results dir)")
    if sha(a.config) != CONFIG_SHA: refuse(f"config {a.config} is not the root-reviewed {CONFIG_SHA[:16]}")
    if out == run_dir or run_dir in out.parents: refuse("--out must be outside the run directory (raw evidence is never written)")
    cfg = json.loads(pathlib.Path(a.config).read_text()); summ = json.loads((run_dir / "summary.json").read_text())
    groups = {g["id"]: evaluate_group(run_dir, g, summ.get("groups", {}).get(g["id"])) for g in cfg["groups"]}
    res = {"kind": "parser-r2 re-evaluation of existing evidence: NO test was re-run", "runId": summ.get("runId"), "runDir": str(run_dir),
           "summarySha256": sha(run_dir / "summary.json"), "configSha256": CONFIG_SHA, "originalRunner": "sdk_regression_runner.py 8138486d (unchanged)",
           "parser": {"libtest_r2.py": sha(H / "libtest_r2.py"), "reevaluate.py": sha(H / "reevaluate.py")},
           "originalCleanup": summ.get("cleanup"), "originalError": summ.get("error"), "groups": groups,
           "correctedAllPass": all(g["corrected"] == "PASS" for g in groups.values())}
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "w") as f: f.write(json.dumps(res, indent=1) + "\n")
    print(json.dumps({"out": str(out), "corrected": {k: v["corrected"] for k, v in groups.items()}, "correctedAllPass": res["correctedAllPass"]}, indent=1))
    sys.exit(0 if res["correctedAllPass"] else 1)


if __name__ == "__main__":
    main()
