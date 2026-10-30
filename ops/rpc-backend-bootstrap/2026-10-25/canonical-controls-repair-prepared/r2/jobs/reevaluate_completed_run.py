#!/usr/bin/env python3
"""Strict RE-EVALUATION of a COMPLETED repaired native mutant run with the r2 classifier (root, after the run has ENDED).
  reevaluate_completed_run.py --run RUN_DIR --queue-log LOGS/NAME --receipt NEW_RECEIPT.json
Re-reads the SAME immutable outputs; NOTHING is rebuilt or re-run, and no native rerun is claimed. Refuses (exit 2, no
receipt) unless: every frozen input is pinned (product patch, PATCHED.sha256, EXPECTED-CONTROLS, the frozen and the
repaired runner + its derivation, v1 and r2 classifiers); the queue log names RUN_DIR as '[ok] fresh', ends with
'[queue] EXIT', has a non-empty .rc and a 'MUTANTS rc=' line; no process uses RUN_DIR; every required mutant from the
UNCHANGED runner has its .build (finished, no error line), .out and an integer .rc. All of RUN_DIR's top-level
*.build/*.out/*.rc/*.verdict + CACHE-REUSED-FROM are hashed before AND after (must be equal) and pinned in the receipt.
Exit 0 only if every REQUIRED mutant (M*) is KILLED by r2; informational I* are reported separately and never counted."""
import argparse, hashlib, json, os, pathlib, re, subprocess, sys
W = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025")
S, RS = W / "verifier-canonical-stage", W / "verifier-canonical-controls-repair"
R2 = RS / "r2/jobs/check_cargo_mutant_r2.py"
PINS = {S / "canonical-block.patch": "41667ec946d2f591498e4ab9d791914a6d5c886221996c5f0c920a0be39dcc31",
        S / "PATCHED.sha256": "7e87fad838fcccdf801fa3ee732ca878b56799f44b4d64973a2265853769b0f3",
        S / "EXPECTED-CONTROLS.txt": "b0409b8a248cf204683d41a90d97a53102470dcaa0527c54314263ffa5bd3a1d",
        S / "jobs/canonical-mutants.sh": "c2264d151d6e19bfdf3dc8caf0dbe9d7d7f1d95603bffbed31c4ce06af166ee2",
        S / "jobs/common.sh": "2c7514948752c436376dac7c34cbad2dbde971f61b0343f26e1997c7eebdba14",
        RS / "jobs/canonical-mutants-repaired.sh": "0709e69a79bdff6dce4ba5956365b96ffa096d1e037f66d7faf37ac618d6a2de",
        RS / "jobs/make-repaired-mutants.py": "12306a14cff6c961d4128fee9b88d7245f5fd108d65a2b014f6dbb07c74c0d7a",
        RS / "jobs/check_cargo_mutant.py": "4bfafa78a3e6200cab8540bae09723f3bd30cf2edb2aae5a71ebac22d9379741",
        R2: "be0d73f302ae73a3022652247a048af933755fb5a302ebff6ef83c6e1501436d"}
REQUIRED = ["M0-base-eeffcc9", "M1-gate-ignores-require-canonical", "M2-gate-accepts-any-block-for-hash", "M3-gate-no-head-age", "M4-cache-stale-index",
            "M5-ancestry-by-number", "M6-node-storage-post-check-removed", "M7-cache-no-descendant-drop", "M8-gate-by-height", "M10-gate-no-link-check",
            "M11-provider-no-exact-postcondition", "M12-node-recheck-disabled"]
INFO = ["I1-cache-filter-only-removed", "I2-cache-unindex-only-removed", "I3-gate-no-above-head-check"]
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def refuse(w): print(f"[REFUSE] {w} (no receipt written)"); sys.exit(2)
ap = argparse.ArgumentParser(); ap.add_argument("--run", required=True); ap.add_argument("--queue-log", required=True); ap.add_argument("--receipt", required=True)
a = ap.parse_args(); run = pathlib.Path(a.run).resolve(); rec = pathlib.Path(a.receipt)
if rec.exists(): refuse(f"{rec} exists")
for p, h in PINS.items():
    if not p.exists() or sha(p) != h: refuse(f"pinned input {p} is not {h[:12]}")
if subprocess.run([sys.executable, "-I", str(RS / "jobs/make-repaired-mutants.py"), "--check", str(S / "jobs/canonical-mutants.sh"), str(RS / "jobs/canonical-mutants-repaired.sh")]).returncode:
    refuse("repaired runner is not the counted derivation of the frozen runner")
if run.parent != RS / "run" or not run.is_dir(): refuse(f"{run} is not a run dir under {RS / 'run'}")
qo, qr = pathlib.Path(a.queue_log + ".out"), pathlib.Path(a.queue_log + ".rc")
try: qtxt, qrc = qo.read_text(errors="replace"), qr.read_text().strip()
except OSError as e: refuse(f"queue log incomplete: {e}")
ql = qtxt.splitlines()
if f"[ok] fresh {run}" not in ql or not ql or not ql[-1].startswith("[queue] EXIT") or not re.fullmatch(r"-?\d+", qrc) or qr.stat().st_mtime < qo.stat().st_mtime:
    refuse("the queue log does not show this run as ENDED (fresh line, final [queue] EXIT, .rc not older than .out)")
mrc = [l for l in ql if re.fullmatch(r"MUTANTS rc=\d+", l)]
if len(mrc) != 1: refuse("no single 'MUTANTS rc=' line: the runner did not finish")
busy = []
for pid in filter(str.isdigit, os.listdir("/proc")):
    for l in ["cwd", "exe"] + [f"fd/{f}" for f in (os.listdir(f"/proc/{pid}/fd") if os.access(f"/proc/{pid}/fd", os.R_OK) else [])]:
        try: t = os.readlink(f"/proc/{pid}/{l}")
        except OSError: continue
        if (t + "/").startswith(str(run) + "/"): busy.append(pid)
if busy: refuse(f"processes still use {run}: {sorted(set(busy))[:5]}")
def snapshot():
    fs = sorted(p for p in run.iterdir() if p.is_file() and (p.suffix in (".build", ".out", ".rc", ".verdict") or p.name == "CACHE-REUSED-FROM"))
    return {p.name: sha(p) for p in fs}
before = snapshot()
# mapping from the UNCHANGED runner
txt = (RS / "jobs/canonical-mutants-repaired.sh").read_text()
T = dict(re.findall(r'(T_[A-Z]+)="([^"]+)"', txt))
calls = {}
for m in re.finditer(r'verdict (\S+) "([^"]+)" ([^;)\n]+)', txt):
    name, bins, names = m.group(1), m.group(2), m.group(3).split()
    bins = re.sub(r"\$(T_[A-Z]+)", lambda x: T[x.group(1)], bins)
    if name in calls: refuse(f"runner calls verdict {name} twice")
    calls[name] = (bins, names)
if sorted(calls) != sorted(REQUIRED + INFO): refuse(f"runner mutant set {sorted(calls)} differs from the expected 12 required + 3 informational")
orig = {m.group(1): m.group(2) for m in re.finditer(r"^(\S+): (KILLED|SURVIVED|INVALID)\b", qtxt, re.M)}
res = {}
for n in REQUIRED + INFO:
    bins, names = calls[n]; b, o, r = run / f"{n}.build", run / f"{n}.out", run / f"{n}.rc"
    e = {"bins": bins, "names": names, "originalRunnerVerdict": orig.get(n)}
    if not b.exists() or not o.exists() or not r.exists(): e.update(r2="INVALID", reason="missing .build/.out/.rc (the build or run did not complete)"); res[n] = e; continue
    bt = b.read_text(errors="replace").splitlines()
    if not any(re.match(r"^\s+Finished `test` profile", l) for l in bt) or any(l.startswith("error") for l in bt):
        e.update(r2="INVALID", reason="--no-run build did not finish cleanly"); res[n] = e; continue
    rc = r.read_text().strip(); e["cargoRc"] = rc
    p = subprocess.run([sys.executable, "-I", str(R2), "--out", str(o), "--rc", rc, "--controls", str(S / "EXPECTED-CONTROLS.txt"), "--bins", bins, *names], capture_output=True, text=True)
    e.update(r2={0: "KILLED", 1: "NOT KILLED"}.get(p.returncode, "INVALID"), r2Exit=p.returncode, r2Output=p.stdout.strip().splitlines(), r2Stderr=p.stderr.strip())
    res[n] = e
after = snapshot()
if after != before: refuse("run outputs changed during re-evaluation")
req_killed = [n for n in REQUIRED if res[n]["r2"] == "KILLED"]
receipt = {"format": "canonical-mutants-reevaluation/v1", "nativeRerun": False,
           "statement": "re-evaluation of the SAME completed native outputs with the corrected r2 classifier; the original runner verdicts (v1 classifier) remain as recorded",
           "run": str(run), "queueLog": {"out": str(qo), "outSha256": sha(qo), "rc": qrc, "mutantsLine": mrc[0]},
           "pinnedInputs": {str(p): h for p, h in PINS.items()}, "runFiles": before,
           "required": {n: res[n] for n in REQUIRED}, "informational": {n: res[n] for n in INFO},
           "summary": {"requiredKilled": f"{len(req_killed)}/{len(REQUIRED)}", "requiredNotKilled": [n for n in REQUIRED if res[n]["r2"] != "KILLED"],
                       "informationalNeverCounted": {n: res[n]["r2"] for n in INFO}}}
rec.write_text(json.dumps(receipt, indent=1) + "\n")
print(json.dumps(receipt["summary"], indent=1)); print(f"## receipt {rec} sha256 {sha(rec)}")
sys.exit(0 if len(req_killed) == len(REQUIRED) else 1)
