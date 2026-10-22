#!/usr/bin/env python3
r"""ROOT-ONLY: run the native NTFS ACL fixture (G4) on minipc. PREPARED by Claude 60543494; NEVER run by its author.
  root-run-acl-fixture.py               local pin check + plan only (no remote call)
  root-run-acl-fixture.py --run         ONE run: new protected stage -> upload acl-fixture.ps1 -> sha-verify -> run from the
                                        verified bytes -> ALWAYS remove the stage (verified) -> runs/result-<ts>.json
  root-run-acl-fixture.py --cleanup <attempt receipt runs/attempt-*.json>   remove THAT attempt's stage, only if its ownership
                                        marker still holds that attempt's token (otherwise: refused, root inspects by hand)
Transport: root's reviewed nucbox-tls-20261021/root-activate-reviewed.py m.ps (pinned; in-session watchdog; <= 7900).
Touches: ONLY a NEW C:\\ProgramData\\Enclave\\staging\\native-acl-<12 hex> (SYSTEM+Administrators, protected). Reads the
privacy-config.json SECURITY DESCRIPTOR only (Get-Acl), never its bytes. No task, service, process or config change; the
staging parent's SDDL is compared before/after. The attempt record (O_EXCL, with a fresh 32-hex ownership TOKEN) is written
before the first remote call; the new stage gets <stage>\.native-acl-owner = TOKEN right after its creation, and NOTHING is
ever deleted unless that marker holds this attempt's token (a refused or unknown mkdir never authorizes a deletion).
Exit 0 ONLY if: fixture pass AND the stage proven gone AND the parent SDDL unchanged."""
import argparse, hashlib, importlib.util, json, os, pathlib, re, subprocess, sys, time, uuid
H = pathlib.Path(__file__).resolve().parent; W = H.parent; OUT = H / "runs"
T = (W / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
FIX = (H / "acl-fixture.ps1", "21d2bcf1705c4b49536882f29151ef74b7cf0417e09740d4fad397274e154b3c")
FUNCS = "38dc1a39d90576d94e5e903079db8c4e00742499f9819995e703d5d4a699b618"     # functions.ps1 (extract.py, helper e369c5e2)
CFG = r"C:\ProgramData\Enclave\network\privacy-config.json"; ROOTDIR = r"C:\ProgramData\Enclave\staging"
# the node.exe root's native writer proof hashed on minipc (outputs/decentralization-audit/native-wallet-writer-proof.json, 21:29Z)
NODE, NODE_SHA = r"C:\Program Files\nodejs\node.exe", "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3"; STAGE_RE = re.compile(r"^C:\\ProgramData\\Enclave\\staging\\native-acl-[0-9a-f]{12}$")
q = lambda v: "'" + str(v).replace("'", "''") + "'"
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
now = lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
U = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"
PARENT = U + r"$p='ROOTX';$o=[ordered]@{exists=(Test-Path -LiteralPath $p)};if($o.exists){$o.sddl=(Get-Acl -LiteralPath $p).Sddl};$o|ConvertTo-Json -Compress"
MKDIR = U + (r"$d=DX;$p='ROOTX';if(-not(Test-Path -LiteralPath $p)){@{decision='refused: the staging root does not exist (never created here)'}|ConvertTo-Json -Compress;exit 0};"
    r"if(Test-Path -LiteralPath $d){@{decision='refused: stage exists'}|ConvertTo-Json -Compress;exit 0};"
    r"$ds=New-Object Security.AccessControl.DirectorySecurity;$ds.SetAccessRuleProtection($true,$false);"
    r"foreach($s in 'S-1-5-18','S-1-5-32-544'){$ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $s),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};"
    r"[void][IO.Directory]::CreateDirectory($d,$ds);[IO.File]::WriteAllText(($d+'\.native-acl-owner'),'TOKENX');$a=Get-Acl -LiteralPath $d;"
    r"$f=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{'S-1-5-18','S-1-5-32-544' -notcontains $_.IdentityReference.Value}).Count;"
    r"[ordered]@{decision='created';stage=$d;protected=$a.AreAccessRulesProtected;foreignRules=$f;sddl=$a.Sddl}|ConvertTo-Json -Compress")
VERIFY = U + r"@{sha=(FileSha FX)}|ConvertTo-Json -Compress"
RUN = U + (r"$p=FX;$b=[IO.File]::ReadAllBytes($p);$h=(-join([Security.Cryptography.SHA256]::Create().ComputeHash($b)|%{$_.ToString('x2')}));"
    r"if($h -ne 'FSHA'){@{decision='refused: the staged fixture is not the pinned bytes'}|ConvertTo-Json -Compress;exit 0};"
    r"& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) -Stage DX -Cfg 'CFGX' -NodeExe 'NODEX' -NodeSha 'NODESHAX'")
# deletes ONLY a real directory (no reparse point) whose marker holds THIS attempt's token; anything else is left for root
CLEAN = U + (r"$d=DX;$o=[ordered]@{existed=(Test-Path -LiteralPath $d)};$o.owned=$false;"
    r"if($o.existed){$i=Get-Item -LiteralPath $d -Force;$mk=Join-Path $d '.native-acl-owner';"
    r"$o.reparse=[bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint);"
    r"$o.owned=(-not $o.reparse) -and $i.PSIsContainer -and (Test-Path -LiteralPath $mk) -and ([IO.File]::ReadAllText($mk) -eq 'TOKENX');"
    r"if($o.owned){Remove-Item -LiteralPath $d -Recurse -Force;$o.decision='removed (ownership marker matched)'}else{$o.decision='refused: not demonstrably created by this attempt (no matching marker, or a reparse point)'}};"
    r"$o.gone=-not(Test-Path -LiteralPath $d);$o.parentSddl=(Get-Acl -LiteralPath 'ROOTX').Sddl;$o|ConvertTo-Json -Compress")
spec = importlib.util.spec_from_file_location("transport", T[0]); m = importlib.util.module_from_spec(spec)

def pins():
    bad = [str(p) for p, h in (T, FIX) if sha(p) != h]
    fx = FIX[0].read_bytes(); fn = (H / "functions.ps1").read_bytes()
    if sha(H / "functions.ps1") != FUNCS or fn not in fx: bad.append("functions.ps1 not pinned / not byte-identical inside the fixture")
    if bad: raise SystemExit(f"local pins differ: {bad}")
    if not hasattr(m, "ps"): spec.loader.exec_module(m)

def save(name, obj):
    OUT.mkdir(exist_ok=True)
    with open(OUT / name, "x") as fh: json.dump(obj, fh, indent=1); fh.flush(); os.fsync(fh.fileno())
    print("receipt:", OUT / name)

def cleanup(stage, token):
    if not STAGE_RE.match(stage) or not re.fullmatch(r"[0-9a-f]{32}", token or ""): raise SystemExit("not a native-acl stage path / ownership token")
    return m.ps(CLEAN.replace("DX", q(stage)).replace("ROOTX", ROOTDIR).replace("TOKENX", token), 120)

def main(argv):
    a = argparse.ArgumentParser(); x = a.add_mutually_exclusive_group(); x.add_argument("--run", action="store_true"); x.add_argument("--cleanup")
    o = a.parse_args(argv); pins(); ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if o.cleanup:
        at = json.loads(pathlib.Path(o.cleanup).read_text())
        if at.get("what") != "attempt": raise SystemExit("--cleanup takes an attempt receipt (runs/attempt-*.json)")
        r = cleanup(at["stage"], at["token"]); save(f"cleanup-{ts}.json", {"what": "cleanup", "at": now(), "stage": at["stage"], "result": r}); print(json.dumps(r))
        return 0 if r.get("gone") and r.get("owned") else 3
    if not o.run:
        print(json.dumps({"pins": "ok", "fixture": FIX[1], "functions": FUNCS, "plan": ["parent SDDL (read)", "new protected stage", "scp fixture", "sha verify",
              "run fixture from verified bytes (<= 240 s)", "remove stage (always)", "parent SDDL (read) == before"]}, indent=1)); return 0
    stage, token = ROOTDIR + "\\native-acl-" + uuid.uuid4().hex[:12], uuid.uuid4().hex
    save(f"attempt-{ts}.json", {"what": "attempt", "at": now(), "stage": stage, "token": token, "fixture": FIX[1]})
    rec = {"what": "result", "at": now(), "stage": stage, "fixture": FIX[1], "functions": FUNCS, "node": [NODE, NODE_SHA]}
    try:
        rec["parentBefore"] = m.ps(PARENT.replace("ROOTX", ROOTDIR), 60)
        rec["mkdir"] = r = m.ps(MKDIR.replace("DX", q(stage)).replace("ROOTX", ROOTDIR).replace("TOKENX", token), 60)
        if r.get("decision") != "created" or r.get("protected") is not True or r.get("foreignRules") != 0: rec["stopped"] = "stage not created protected"
        else:
            c = subprocess.run(["timeout", "120", "scp", "-q", "-o", "BatchMode=yes", str(FIX[0]), "minipc:/" + (stage + "\\acl-fixture.ps1").replace("\\", "/")], capture_output=True, text=True)
            if c.returncode: rec["stopped"] = "upload failed: " + c.stderr[-200:]
            else:
                rec["verify"] = v = m.ps(VERIFY.replace("FX", q(stage + "\\acl-fixture.ps1")), 60)
                if v.get("sha") != FIX[1]: rec["stopped"] = "staged fixture is not the pinned bytes"
                else: rec["fixture_result"] = m.ps(RUN.replace("FX", q(stage + "\\acl-fixture.ps1")).replace("FSHA", FIX[1]).replace("DX", q(stage)).replace("CFGX", CFG)
                                                   .replace("NODEX", NODE).replace("NODESHAX", NODE_SHA), 240)
    finally:
        # ALWAYS asked, and it deletes ONLY a stage whose marker holds this attempt's token (also after an unknown mkdir outcome)
        try: rec["cleanup"] = cl = cleanup(stage, token)
        except Exception as e: rec["cleanup"] = cl = {"error": str(e)[:300]}
        rec["parentUnchanged"] = bool(rec.get("parentBefore", {}).get("sddl")) and cl.get("parentSddl") == rec["parentBefore"]["sddl"]
        rec["verdict"] = bool(rec.get("fixture_result", {}).get("pass") is True and cl.get("gone") is True and cl.get("owned") is True and rec["parentUnchanged"])
        save(f"result-{ts}.json", rec)
        print(json.dumps({"verdict": rec["verdict"], "pass": rec.get("fixture_result", {}).get("pass"), "stopped": rec.get("stopped"), "cleanup": cl.get("decision"),
                          "stageGone": cl.get("gone"), "parentUnchanged": rec["parentUnchanged"]}, indent=1))
    return 0 if rec["verdict"] else 3

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
