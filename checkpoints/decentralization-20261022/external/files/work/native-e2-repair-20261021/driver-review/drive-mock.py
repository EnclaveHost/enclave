#!/usr/bin/env python3
"""LOCAL ONLY review aid for compose5-review/root-hs2-r5.py (never contacts minipc).
1. dumps every remote PowerShell text the driver would send (texts/*.ps1) and checks for leftover placeholders;
2. runs the driver's main() with the transport's ps() and scp replaced by canned answers, in a temp OUT dir, and
   records: whether the attempt record existed BEFORE the helper session, the verdict/exit code per helper outcome.
"""
import importlib.util, json, os, pathlib, subprocess, sys, tempfile, types

HERE = pathlib.Path(__file__).resolve().parent
WORK = HERE.parents[1]
DRV = pathlib.Path(os.environ.get("DRV") or WORK / "compose5-review/root-hs2-r5.py")
sp = importlib.util.spec_from_file_location("drv", DRV); d = importlib.util.module_from_spec(sp); sp.loader.exec_module(d)
if DRV.parent != WORK / "compose5-review":  # the proposed copy lives here: point it at the same pinned inputs
    d.TRANSPORT = (WORK / "nucbox-tls-20261021/root-activate-reviewed.py", d.TRANSPORT[1]); d.HELPER = (WORK / "host-service-tls-20261021/upgrade/hs2-upgrade.ps1", d.HELPER[1])
    d.BUNDLE = WORK / "host-service-tls-20261021/upgrade-bundle-r5"
TAG = os.environ.get("TAG", "orig")
real_m, man = d.verify_local()

# ---- 1. texts
td = HERE / ("texts-" + TAG); td.mkdir(exist_ok=True)
stage = d.STAGING + r"\hs2up-r5-0123456789ab"
texts = {"facts": d.facts_text(man, "20261021000000-0123abcd"), "facts-norun": d.facts_text(man, ""), "health": d.health_text(man),
         "mkstage": d.MKSTAGE.replace("DX", stage), "staged": d.STAGED.replace("DX", stage).replace("SRELS", d.srels())}
for md, arg in (("Upgrade", ""), ("Revert", "20261021000000-0123abcd"), ("Recover", "")):
    texts["run-" + md] = d.run_text(stage, md, d.helper_args(md, arg))
for k, t in texts.items():
    (td / f"{k}.ps1").write_text(real_m.HEAD.replace("SECS", "2400") + t)
bal = {k: (t.count("{") - t.count("}"), t.count("(") - t.count(")")) for k, t in texts.items()}
print("brace/paren balance:", bal)
import base64
print("encoded lengths (HEAD SECS=2400):", {k: len(base64.b64encode((real_m.HEAD.replace("SECS", "2400") + t).encode("utf-16-le"))) for k, t in texts.items()})

# ---- 2. mocked main()
H = {r["path"]: r for r in man["replace"]}
def files(which):
    f = {r["path"]: r[which] for r in man["replace"]}; f.update({u["path"]: u["sha"] for u in man["unchanged"]}); return f
RID = "20261021180000-0123abcd"
def facts(which, lock=None, journal=None, receipt=None, task="Running", xml="x" * 64):
    return {"at": "t", "files": files(which), "config": man["config"][which], "receipt": receipt or man["receipt"]["old"],
            "taskState": task, "taskXmlSha": xml, "lock": lock, "journal": journal, "freeMiB": 4096, "freeDiskMiB": 99999, "helpers": 0}
HEALTH0 = {"exit": 0, "checks": ["PASS task"]}

class M:
    def __init__(self, script): self.script = list(script); self.calls = []; self.HEAD = real_m.HEAD
    def ps(self, text, secs=150):
        kind = "run" if "-ManifestSha256" in text else "health" if "(PASS|FAIL)" in text else \
               "staged" if "ParseFile" in text else "mkstage" if "stage exists" in text else "facts"
        att = sorted(p.name for p in d.OUT.glob("attempt-*"))
        self.calls.append((kind, secs, att))
        for i, (k, v) in enumerate(self.script):
            if k == kind: self.script.pop(i); return v(text) if callable(v) else v
        raise AssertionError(f"unexpected {kind}")

def run_case(name, script, argv_extra, pre_facts=None, mode="--execute", pre_runid=""):
    out = pathlib.Path(tempfile.mkdtemp(prefix="drv-")); d.OUT = out
    pre = {"what": "preflight", "at": d.now(), "runId": pre_runid,
           "evidence": {"facts": pre_facts or facts("old"), "health": HEALTH0}, "gates": {"upgrade": [], "revert": []}}
    if mode == "--execute": pre["gates"] = {"upgrade": []}
    pp = out / "pre.json"; pp.write_text(json.dumps(pre))
    sr = out / "stage.json"; sr.write_text(json.dumps({"what": "stage", "ok": True, "stage": stage}))
    m = M(script); d.verify_local = lambda: (m, man)
    argv = [mode] + argv_extra + ["--preflight", str(pp), "--stage-receipt", str(sr), "--manifest-sha", d.MSHA, "--helper-sha", d.HELPER[1]]
    import io, contextlib
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf): rc = d.main(argv)
    except SystemExit as e: rc = f"SystemExit({e.code})"
    except Exception as e: rc = f"EXC {type(e).__name__}: {e}"
    lines = [l for l in buf.getvalue().splitlines() if l and not l.startswith((" ", "{", "}", "]"))]
    runcall = [c for c in m.calls if c[0] == "run"]
    print(f"{name:34s} rc={rc!s:6s} attemptBeforeRun={runcall[0][2] if runcall else '-'} verdict={lines[-1][:150] if lines else ''}")
    return rc

def res(exit_, result, started=True):
    return {"started": started, "exit": exit_, "result": json.dumps(result) if result is not None else None, "other": ""}
newj = {"journal": {"manifest": d.MSHA, "phase": "complete", "receiptNew": "e" * 64}, "revert-journal": None}
ok_post = [("facts", facts("new", journal=newj, receipt="e" * 64)), ("health", HEALTH0)]
old_post = [("facts", facts("old")), ("health", HEALTH0)]
fresh = [("facts", facts("old")), ("health", HEALTH0)]

run_case("upgrade ok", fresh + [("run", res(0, {"ok": True, "exit": 0, "runId": RID}))] + ok_post, [])
run_case("upgrade exit0 but post old", fresh + [("run", res(0, {"ok": True, "exit": 0, "runId": RID}))] + old_post, [])
run_case("upgrade exit2", fresh + [("run", res(2, {"ok": False, "exit": 2, "runId": RID}))] + old_post, [])
run_case("upgrade exit1", fresh + [("run", res(1, {"ok": False, "exit": 1}))] + old_post, [])
run_case("upgrade exit3", fresh + [("run", res(3, {"ok": False, "exit": 3, "runId": RID}))] + old_post, [])
run_case("upgrade no RESULT (exit 1, throw)", fresh + [("run", res(1, None))] + old_post, [])
run_case("upgrade transport timeout", fresh + [("run", {"error": "no output (ssh rc 124)", "stderr": ""})] + old_post, [])
run_case("upgrade ssh rc!=0 w/ json", fresh + [("run", {"error": "ssh rc 1", "result": res(0, {"ok": True, "exit": 0, "runId": RID})})] + ok_post, [])
run_case("upgrade staged drift", fresh + [("run", {"started": False, "error": "staged drift"})] + old_post, [])
run_case("upgrade RESULT exit != process exit", fresh + [("run", res(0, {"ok": False, "exit": 3, "runId": RID}))] + ok_post, [])
# a second execute in the same OUT must refuse before any remote helper call
out_keep = None
def second():
    out = pathlib.Path(tempfile.mkdtemp(prefix="drv-")); (out / "attempt-upgrade.json").write_text("{}")
    return out
o2 = second(); d.OUT = o2
m = M(fresh); d.verify_local = lambda: (m, man)
pre = {"what": "preflight", "at": d.now(), "runId": "", "evidence": {"facts": facts("old"), "health": HEALTH0}, "gates": {"upgrade": []}}
(o2 / "p.json").write_text(json.dumps(pre)); (o2 / "s.json").write_text(json.dumps({"what": "stage", "ok": True, "stage": stage}))
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    rc = d.main(["--execute", "--preflight", str(o2 / "p.json"), "--stage-receipt", str(o2 / "s.json"), "--manifest-sha", d.MSHA, "--helper-sha", d.HELPER[1]])
print(f"{'existing attempt record':34s} rc={rc} calls={[c[0] for c in m.calls]}")

# revert: preflight with --run-id; task must be Running for the driver's gate
rv_pre = facts("new", journal=newj, receipt="e" * 64)
run_case("revert ok", [("facts", rv_pre), ("health", HEALTH0), ("run", res(0, {"ok": True, "exit": 0, "runId": RID}))] + old_post,
         [RID], pre_facts=rv_pre, mode="--revert", pre_runid=RID)
rv_stop = facts("new", journal=newj, receipt="e" * 64, task="Ready")
run_case("revert when task stopped (Ready)", [("facts", rv_stop), ("health", {"exit": 2, "checks": ["FAIL  task"]})],
         [RID], pre_facts=rv_stop, mode="--revert", pre_runid=RID)
# recover
rc_pre = facts("new", lock=RID, receipt="e" * 64, task="Running")
run_case("recover ok (task left stopped)", [("facts", rc_pre), ("health", HEALTH0), ("run", res(0, {"ok": True, "exit": 0, "runId": RID})),
         ("facts", facts("old", task="Ready")), ("health", {"exit": 2, "checks": []})], [RID], pre_facts=rc_pre, mode="--recover")
run_case("recover lock text mismatch", [("facts", rc_pre), ("health", HEALTH0)], ["20261021180000-ffffffff"], pre_facts=rc_pre, mode="--recover")

# B1: an orphaned helper is still running (ssh lost) -> UNKNOWN must say so; --recover must refuse beside it
live = dict(facts("new", lock=RID, receipt="e" * 64), helpers=1)
run_case("UNKNOWN with live helper", fresh + [("run", {"error": "no output (ssh rc 255)", "stderr": ""}), ("facts", live), ("health", HEALTH0)], [])
run_case("recover beside a live helper", [("facts", live), ("health", HEALTH0)] + [("run", res(0, {"ok": True, "exit": 0, "runId": RID}))] + [("facts", facts("old", task="Ready")), ("health", HEALTH0)],
         [RID], pre_facts=live, mode="--recover")
