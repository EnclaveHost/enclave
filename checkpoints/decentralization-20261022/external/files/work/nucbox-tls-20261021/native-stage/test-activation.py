#!/usr/bin/env python3
"""CAS fixture tests of root-activate.py's EXACT generated install/rollback PowerShell, on minipc, in staging only.

Fixtures: C:\\ProgramData\\Enclave\\hotfix\\nucbox-stopfix-20261021\\cas-test\\<case>\\ hold copies of the ORIGINAL live
files (wmiserve-run.mjs c0154d17 from the staging mut\\ copy; server.mjs ec91cb03 from the liveness staging
server.mjs.before), optionally altered. The step text is step_texts(..., mdir=<fixture dir>): the target directory is
the only difference from what --execute runs. No Program Files path is read or written by these cases.
"""
import importlib.util, json, os, subprocess, sys, tempfile, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ra", os.path.join(HERE, "..", "root-activate.py"))
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)
T = ra.STAGE + r"\cas-test"
ORIG_W, ORIG_S = ra.STAGE + r"\mut\wmiserve-run.mjs", r"C:\ProgramData\Enclave\hotfix\enclavedns-liveness-20261021\server.mjs.before"
LW, LS = ra.FILES["wmiserve-run.mjs"]["live"], ra.FILES["server.mjs"]["live"]
NW, NS = ra.FILES["wmiserve-run.mjs"]["new"], ra.FILES["server.mjs"]["new"]
BW, BS = ra.FILES["wmiserve-run.mjs"]["bak"], ra.FILES["server.mjs"]["bak"]

def upload(name, text):
    body = ra.full_text(text).encode("utf-8")
    with tempfile.NamedTemporaryFile("wb", delete=False) as f: f.write(body)
    try: subprocess.run(["timeout", "120", "scp", "-q", "-o", "BatchMode=yes", f.name,
                         "minipc:/C:/ProgramData/Enclave/hotfix/nucbox-stopfix-20261021/cas-test/texts/%s.txt" % name], check=True)
    finally: os.unlink(f.name)
    return hashlib.sha256(body).hexdigest()

def run_case(case, text_name, text_sha, setup):
    """setup: 'fresh' | 'fresh-mismatch-w' | 'fresh-mismatch-s' | 'fresh-backup-clash' | 'reuse:<case>'"""
    d = T + "\\" + (setup.split(":", 1)[1] if setup.startswith("reuse:") else case)
    prep = ""
    if not setup.startswith("reuse:"):
        prep = (f"if(-not $d.StartsWith('{T}\\')){{throw 'path'}};if(Test-Path -LiteralPath $d){{Remove-Item -LiteralPath $d -Recurse -Force}};"
                f"$null=New-Item -ItemType Directory -Path $d;Copy-Item -LiteralPath '{ORIG_W}' -Destination \"$d\\wmiserve-run.mjs\";"
                f"Copy-Item -LiteralPath '{ORIG_S}' -Destination \"$d\\server.mjs\";")
        if setup == "fresh-mismatch-w": prep += "Add-Content -LiteralPath \"$d\\wmiserve-run.mjs\" -Value '// fixture mismatch';"
        if setup == "fresh-mismatch-s": prep += "Add-Content -LiteralPath \"$d\\server.mjs\" -Value '// fixture mismatch';"
        if setup == "fresh-backup-clash": prep += f"Set-Content -LiteralPath \"$d\\{BW}\" -Value 'other bytes';"
    drv = (f"$d='{d}';" + prep +
           "function State{$s=[ordered]@{};foreach($f in @(Get-ChildItem -LiteralPath $d -File|Sort-Object Name)){$s[$f.Name]=FileSha $f.FullName};$s};"
           "$before=State;"
           f"$p='{T}\\texts\\{text_name}.txt';if((FileSha $p) -ne '{text_sha}'){{throw 'text hash'}};"
           # the exact text includes HEAD (watchdog + FileSha); its body is run as a script block inside try/catch
           "$res=try{[ordered]@{output=[string](& ([scriptblock]::Create([IO.File]::ReadAllText($p))))}}catch{[ordered]@{threw=[string]$_.Exception.Message}};"
           "[ordered]@{before=$before;result=$res;after=(State)}|ConvertTo-Json -Depth 4 -Compress")
    return ra.ps(drv, 120)

def main():
    both, wonly = ra.files([]), ra.files(["--wmiserve-only"])
    mk = ra.ps(f"$null=New-Item -ItemType Directory -Force -Path '{T}\\texts';[ordered]@{{ok=$true}}|ConvertTo-Json -Compress")
    if mk.get("ok") is not True: print("setup failed", mk); return 2
    texts = {}
    for name, fs, mode, case in (("install-both-orig", both, "install", "orig"), ("rollback-both-orig", both, "rollback", "orig"),
                                 ("install-both-mw", both, "install", "mw"), ("install-both-ms", both, "install", "ms"),
                                 ("install-both-clash", both, "install", "clash"), ("install-wonly", wonly, "install", "wonly")):
        texts[name] = upload(name, ra.step_texts(fs, mode, mdir=T + "\\" + case)[0])
    R, fails = {}, []
    def check(label, cond, detail):
        R[label] = {"ok": bool(cond), "detail": detail}
        if not cond: fails.append(label)
    r = run_case("orig", "install-both-orig", texts["install-both-orig"], "fresh")
    a = r.get("after", {}); out = json.loads(r["result"]["output"]) if "output" in r.get("result", {}) else {}
    check("install on originals: both replaced, backups = originals, node --check 0/0, no temp leftovers",
          a.get("wmiserve-run.mjs") == NW and a.get("server.mjs") == NS and a.get(BW) == LW and a.get(BS) == LS
          and out.get("nodeCheckWmiserve") == 0 and out.get("nodeCheckServer") == 0 and not any(".new-" in k for k in a), r)
    st = a
    r = run_case("orig", "install-both-orig", texts["install-both-orig"], "reuse:orig")
    check("install again (already new): CAS refused, nothing changed",
          "CAS refused" in r.get("result", {}).get("threw", "") and r.get("after") == st, r)
    r = run_case("orig", "rollback-both-orig", texts["rollback-both-orig"], "reuse:orig")
    a = r.get("after", {})
    check("rollback: originals back, backups kept, no temp leftovers",
          a.get("wmiserve-run.mjs") == LW and a.get("server.mjs") == LS and a.get(BW) == LW and a.get(BS) == LS
          and not any(".new-" in k for k in a) and "output" in r.get("result", {}), r)
    st = a
    r = run_case("orig", "rollback-both-orig", texts["rollback-both-orig"], "reuse:orig")
    check("rollback again (already original): CAS refused, nothing changed",
          "CAS refused" in r.get("result", {}).get("threw", "") and r.get("after") == st, r)
    r = run_case("mw", "install-both-mw", texts["install-both-mw"], "fresh-mismatch-w")
    check("first file mismatched: CAS refused, NOTHING changed, no backup", "CAS refused" in r.get("result", {}).get("threw", "")
          and r.get("after") == r.get("before") and BW not in r.get("after", {}) and BS not in r.get("after", {}), r)
    r = run_case("ms", "install-both-ms", texts["install-both-ms"], "fresh-mismatch-s")
    check("SECOND file mismatched: refused before ANY change (wmiserve untouched too), no backup",
          "CAS refused" in r.get("result", {}).get("threw", "") and r.get("after") == r.get("before")
          and r.get("after", {}).get("wmiserve-run.mjs") == LW and BW not in r.get("after", {}), r)
    r = run_case("clash", "install-both-clash", texts["install-both-clash"], "fresh-backup-clash")
    check("a backup with other bytes already present: refused, nothing changed",
          "other bytes" in r.get("result", {}).get("threw", "") and r.get("after") == r.get("before"), r)
    r = run_case("wonly", "install-wonly", texts["install-wonly"], "fresh")
    a = r.get("after", {})
    check("--wmiserve-only (ONE row): wmiserve replaced, server.mjs untouched, one backup",
          a.get("wmiserve-run.mjs") == NW and a.get("server.mjs") == LS and a.get(BW) == LW and BS not in a, r)
    print(json.dumps(R, indent=1))
    print(f"{len(R) - len(fails)}/{len(R)} PASS" + (f"; FAILED: {fails}" if fails else ""))
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
