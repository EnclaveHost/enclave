#!/usr/bin/env python3
"""COMPOUND gate for the combined release (root, read-only). Run 2's ORIGINAL receipt is pass:false (ignoredTotal 1) and stays
so; the release instead requires the reviewed CLI-child compound evidence, re-verified HERE by RE-RUNNING the pinned checker
over the actual files (the stored compoundAccepted boolean is never trusted on its own).
  check-compound-gate.py --child-stage DIR --receipts DIR --run2-logs DIR --supplement DIR --attempt N \
                         --compound-sha HEX --launcher-sha HEX --child-out-sha HEX --supplement-manifest-sha HEX
Refuses unless ALL hold:
  1. the child stage == its MANIFEST f3d45ccb (checker cd2e2e58, pins 4e7c14f1, cases runner, checker tests), nothing unlisted;
  2. run 2's ORIGINAL receipts are byte-identical to the actual ones (receipt b4162de1, out 6f22c072, rc 9a271f2a) and the 8
     phase logs to their pins; the receipt still says pass:false, ignoredTotal 1, systemdRunExit 0, aggregate rc=0, 8 result
     lines, repair manifest 1864c852; run-2.out has the 8 phase verdicts, 5 REBUILT builds and both exact control sets;
  3. the ONLY ignored test anywhere is the pinned CLI child with its pinned annotation (no ignore whitelist);
  4. cli-child-<N>.{compound.json,launcher.json,out} equal the root-supplied pins; the supplement output dir equals its pinned
     manifest (results.json + 49 runs x stdout/stderr = 99 files, nothing else);
  5. RE-RUNNING the pinned checker on those files exits 0 with compoundAccepted true, no failures, originalReceiptPass false,
     summary 45/3/true, and its output is byte-identical to the stored compound.json; the launcher's .out reports it.
Prints the accepted evidence pins as JSON (exit 0) or one reason per line (exit 1)."""
import argparse, hashlib, json, pathlib, re, subprocess, sys
CHILD_MANIFEST = "f3d45ccbcb9fce94cd87957baacbc879b37395c3682006aa73671e1560f79708"
CHECKER, PINS = "cd2e2e58c3595a7204d0cdb73299f009c315efe34be9abe669cb3535a2cc7ac5", "4e7c14f1969c5f5af3e648a82033c1f7cfee718c20f3cb1d4d49ff3d90151750"
RUN2 = {"run-2.receipt.json": "b4162de1dcf1c09271eea2a770c599eaa70b285bfb1630f1c5792e520af42001",
        "run-2.out": "6f22c072d664e34043aadc6e634ed53c0289b8c2df2b6239fe988c82437a02b1", "run-2.rc": "9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa"}
LOGS = {"cli.test.out": "a12d3d540017f3d46941eebb1daca3633bd673863caad5d45a28f6b1e2885534", "control-engine.test.out": "95c2291b54915c5c2d9f4f4982ae1fc458a178c672fce09584407f6047013a3b",
        "control-node.test.out": "3f36e45167947b5e53c542ab9d3840aaa5281311d4d36ec8ca19834d1ab7ff8a", "engine.test.out": "f4e1a1ba4c441e7e44c3e0b6ab96afc1514b1ba8db2696f51b9481147b9e62db",
        "node-derivation.test.out": "a2566e39443f83655146ab33291e230969fd1be6a63afc6144031bc5f29b3af0", "node-safedb.test.out": "6fafc45aaecc2056bb1a5af79993e3c354033cf49d5bec9410b3e9d24d76f38a",
        "node-seq.test.out": "17aceea81f1e3bc8bbead24a93b10100c9ea5e7833c6deb895140c6880df7331", "node.test.out": "0e30b52a0d6f4c2e212203b5485f58d978e0dc08bf168b227a477c2475c8b3c1"}
REPAIR = "1864c8526dd9487d5a07a12d311f8d887214fe85eed66eb9d9d8535e126b6d29"
CHILD, NOTE = "node::tests::validates_sequencer_key_from_env_child", "spawned by validates_sequencer_key_from_env with isolated process env"
PHASES = ["engine", "node", "node-seq", "node-safedb", "node-derivation", "cli"]
CONTROLS = {"control-engine": "precondition_refuses_replayed_snapshot_labels_above_n precondition_refuses_wrong_number_wrong_hash_and_rpc_claimed_hash",
            "control-node": "a_failing_reset_is_fatal real_redb_wipe_removes_snapshot_entries_persistently"}
sha = lambda b: hashlib.sha256(b).hexdigest()
fails = []
def need(c, why):
    if not c: fails.append(why)
    return c
def rd(p):
    try: return pathlib.Path(p).read_bytes()
    except OSError: fails.append(f"missing {p}"); return b""
def dir_manifest(d):
    d = pathlib.Path(d); fs = sorted(p for p in d.rglob("*") if p.is_file() or p.is_symlink())
    need(not any(p.is_symlink() for p in fs), f"symlink in {d}")
    return sha("".join(f"{sha(p.read_bytes())}  {p.relative_to(d)}\n" for p in fs if p.is_file()).encode()), len(fs)
ap = argparse.ArgumentParser()
for k in ("child-stage", "receipts", "run2-logs", "supplement", "attempt", "compound-sha", "launcher-sha", "child-out-sha", "supplement-manifest-sha"): ap.add_argument("--" + k, required=True)
a = ap.parse_args()
for k in ("compound_sha", "launcher_sha", "child_out_sha", "supplement_manifest_sha"):
    if not re.fullmatch(r"[0-9a-f]{64}", getattr(a, k)): print(f"[REFUSE] --{k.replace('_', '-')} is not a sha256"); sys.exit(1)
if not re.fullmatch(r"[1-9]", a.attempt): print("[REFUSE] --attempt must be 1-9"); sys.exit(1)
cs, rec, logs, sup = (pathlib.Path(x) for x in (a.child_stage, a.receipts, a.run2_logs, a.supplement))
# 1. reviewed child stage
man = rd(cs / "MANIFEST.sha256")
if need(sha(man) == CHILD_MANIFEST, "child stage MANIFEST.sha256 is not the reviewed f3d45ccb"):
    listed = {}
    for l in man.decode().splitlines():
        h, _, f = l.partition("  "); listed[f] = h
    for f, h in listed.items(): need(sha(rd(cs / f)) == h, f"child stage {f} differs from its MANIFEST")
    present = {str(p.relative_to(cs)) for p in cs.rglob("*") if p.is_file()} - {"MANIFEST.sha256"}
    need(present == set(listed), f"child stage has unlisted/missing files: {sorted(present ^ set(listed))[:5]}")
    need(listed.get("checker/check_compound.py") == CHECKER and listed.get("pins/pins.json") == PINS, "checker or pins are not the reviewed ones")
# 2. original run 2 (kept pass:false)
for f, h in RUN2.items(): need(sha(rd(rec / f)) == h, f"original run-2 {f} is not the actual receipt {h[:12]}")
for f, h in LOGS.items(): need(sha(rd(logs / f)) == h, f"run-2 log {f} differs from its pin")
need(sorted(p.name for p in logs.glob("*.test.out")) == sorted(LOGS), "run-2 log set is not exactly the 8 pinned logs")
try: r = json.loads(rd(rec / "run-2.receipt.json"))
except ValueError: r = {}; fails.append("run-2 receipt is not JSON")
for k, v in {"attempt": 2, "systemdRunExit": 0, "aggregateLine": "## aggregate rc=0", "testResultLines": 8, "ignoredTotal": 1, "pass": False, "stageManifestSha256": REPAIR}.items():
    need(r.get(k) == v and type(r.get(k)) is type(v), f"original receipt {k}={r.get(k)!r}, required {v!r}")
out = rd(rec / "run-2.out").decode(errors="replace").splitlines()
for bad in ("## INVALID", "M10 test missing or not ok", "DID NOT FAIL AS EXPECTED", "FAILED (rc="): need(not any(bad in l for l in out), f"run-2.out contains '{bad}'")
for ph in PHASES: need(out.count(f"## {ph} OK") == 1, f"run-2 phase {ph} not OK exactly once")
need(out.count("## aggregate rc=0") == 1, "run-2 aggregate line")
rb = sorted(m.group(1) for l in out for m in [re.fullmatch(r"## ([a-z-]+): REBUILT \S+ sha256 [0-9a-f]{64}", l)] if m)
need(rb == sorted(["engine", "node", "cli", "control-engine", "control-node"]), f"run-2 REBUILT builds {rb}")
for c, s in CONTROLS.items():
    need(out.count(f"## {c} failed exactly as expected") == 1, f"run-2 {c} not exact")
    fl = [l for l in out if l.startswith(f"## {c} rc=")]
    need(len(fl) == 1 and re.fullmatch(rf"## {c} rc=(?!0\b)\d+ failing: {re.escape(s)} ?", fl[0] if fl else ""), f"run-2 {c} failing set {fl!r}")
# 3. the only ignored test is the pinned child (no whitelist)
ign = []
for f in LOGS:
    t = rd(logs / f).decode(errors="replace")
    ign += [(f, m.group(0)) for m in re.finditer(r"^test \S+ \.\.\. ignored.*$", t, re.M)]
    for m in re.finditer(r"^test result: .* (\d+) ignored;", t, re.M): need(m.group(1) == ("1" if f == "cli.test.out" else "0"), f"{f} reports {m.group(1)} ignored")
need(ign == [("cli.test.out", f"test {CHILD} ... ignored, {NOTE}")], f"ignored tests are not exactly the pinned child: {ign}")
# 4. supplement evidence pinned by root
n = a.attempt; comp_b = rd(rec / f"cli-child-{n}.compound.json")
need(sha(comp_b) == a.compound_sha, "compound.json differs from its pin")
need(sha(rd(rec / f"cli-child-{n}.launcher.json")) == a.launcher_sha, "launcher.json differs from its pin")
cout = rd(rec / f"cli-child-{n}.out"); need(sha(cout) == a.child_out_sha, "cli-child .out differs from its pin")
if sup.is_dir():
    m, cnt = dir_manifest(sup); need(m == a.supplement_manifest_sha, "supplement output dir differs from its pinned manifest"); need(cnt == 99, f"supplement output has {cnt} files, not 99")
else: fails.append(f"missing supplement dir {sup}")
# 5. re-run the pinned checker (never trust the stored boolean)
if not fails:
    p = subprocess.run([sys.executable, "-I", str(cs / "checker/check_compound.py"), "--pins", str(cs / "pins/pins.json"), "--run2-receipts", str(rec),
                        "--run2-logs", str(logs), "--supplement", str(sup), "--launcher", str(rec / f"cli-child-{n}.launcher.json")], capture_output=True)
    try: v = json.loads(p.stdout)
    except ValueError: v = {}; fails.append("re-run checker output is not JSON")
    need(p.returncode == 0, f"re-run checker exit {p.returncode}")
    need(v.get("compoundAccepted") is True and v.get("failures") == [] and v.get("originalReceiptPass") is False, f"re-run checker verdict {v.get('compoundAccepted')!r} {v.get('failures', [])[:3]}")
    need(v.get("summary") == {"nonIgnoredPassed": 45, "childPassed": 3, "controlKilledByAssertion": True}, f"re-run summary {v.get('summary')}")
    need(p.stdout == comp_b, "stored compound.json is not byte-identical to the re-run checker output")
    cl = cout.decode(errors="replace").splitlines()
    need("## compoundAccepted: True" in cl and not any(l.startswith("## REASON:") for l in cl), "cli-child .out does not report compoundAccepted True cleanly")
if fails:
    for f in fails: print(f"[REFUSE] {f}")
    sys.exit(1)
print(json.dumps({"format": "m7-m10-release-compound-gate/v1", "accepted": True, "originalRun2": dict(RUN2), "originalRun2Pass": False,
                  "childStageManifest": CHILD_MANIFEST, "checker": CHECKER, "pins": PINS, "attempt": int(n), "compoundSha256": a.compound_sha,
                  "launcherSha256": a.launcher_sha, "childOutSha256": a.child_out_sha, "supplementManifestSha256": a.supplement_manifest_sha}, indent=1))
