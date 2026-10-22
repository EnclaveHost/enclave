#!/usr/bin/env python3
"""ROOT-ONLY driver: hs2 G3 -> G4 (service-tls fronts the challenge origin; orders stay HELD) in-place upgrade on minipc.
COPY of g3-final-package/root-hs2-g3.py 69fbc046 (root-reviewed, executed by root 20:57Z) by reviewer 9d; NEVER run by 9d
(no remote call made). Changes vs the G3 driver: ONLY the G4 bundle pins, root-g4/ receipts, hs2up-g4- staging and texts.
(G3 header) hs2 r5 -> G3 (service-tls added, orders HELD; A5 route-dns source) in-place upgrade on minipc.
COPY of compose5-review/root-hs2-r5.py (reviewed, executed by root 19:58Z) by Claude 7d; NEVER run by 7d (no remote call made).
Changes vs the r5 driver: the G3 bundle pins, WORK path, root-g3/ receipts, hs2up-g4- staging, and the manifest's `add`
files are read and gated (absent before, the pinned new sha after). Everything else is the r5 driver; its text below still
says r5 where it describes the shared mechanics.
(r5 header) hs2 r3 -> r5 in-place upgrade on minipc. PREPARED by reviewer 9d.
It adds no swap/rollback logic of its own. Every change is made by the reviewed helper hs2-upgrade.ps1 b17360b2, over the
reviewed transport nucbox-tls-20261021/root-activate-reviewed.py c50aac8e (m.ps: in-session watchdog, encoded <= 7900).

  root-hs2-r5.py [--run-id R]              read-only preflight (pins, task, lock, free memory, health) -> root-r5/preflight-*.json
  root-hs2-r5.py --stage --preflight P     NEW unique C:\\ProgramData\\Enclave\\staging\\hs2up-g4-<uuid12>: upload the 9 bundle files +
                                           the helper, verify every sha there, ParseFile the helper -> root-r5/stage-*.json
  root-hs2-r5.py --execute --stage-receipt S --preflight P --manifest-sha <418ca1d1..> --helper-sha <b17360b2..>
  root-hs2-r5.py --revert R --stage-receipt S --preflight P(--run-id R) --manifest-sha .. --helper-sha ..
  root-hs2-r5.py --recover LOCKID|EMPTY --stage-receipt S --preflight P --manifest-sha .. --helper-sha ..
  root-hs2-r5.py --selfcheck               LOCAL only: pins on disk; build every remote text; check the encoded lengths
Execute/revert/recover: a fresh read-only preflight, then root-r5/attempt-<kind>.json is created (O_EXCL, fsync) BEFORE the
helper session. An existing attempt record refuses: an attempt is never retried automatically. Root inspects, then moves
the record aside deliberately. Then one bounded helper session, then ALWAYS post evidence (pins, task, lock, run journal
phase, health check names). Exit: 0 verified; 1 refused (no change); 2 helper failed + restored; 3 ROOT (unknown, needs
recover/inspection); 4 local refusal (no remote change attempted).
Never read: config content, logs, keys. Read: file sha256s, task state + exported-XML sha, lock text (a run id), the
run journal's manifest/phase/receiptNew, and health PASS/FAIL check names (details dropped).
"""
import argparse, base64, calendar, hashlib, importlib.util, json, os, pathlib, re, subprocess, sys, time, uuid

HERE = pathlib.Path(__file__).resolve().parent
WORK = HERE.parent.parent          # g4 -> challenge-host-tls-20261021 -> work
TRANSPORT = (WORK / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
HELPER = (WORK / "host-service-tls-20261021/upgrade/hs2-upgrade.ps1", "b17360b2bb77b6bce393064022dfd7ce1a8d399e96693d91dc53aea420dc935c")
BUNDLE = WORK / "challenge-host-tls-20261021/g4/upgrade-bundle-g4"
MSHA = "afe3efb59b01cfa5fceef6411353c05d0e005fae48a86df8dcddf3612cecdb66"
BUNDLE_FILES = {  # bundle-relative path -> sha256 (the manifest itself + config + the 5 replaced files; G4 adds none)
    "upgrade-manifest.json": MSHA,
    "config/host-services.json": "a02e9ecd8ae1739eed8d324b4db33fe9b6d5643b5d781780949f61a1385c7cfa",
    "files/STAGE-SHA256SUMS": "1fd2bda64de77e744220ac488cc760e3508b5d4ebcec110d0c2de12b5f356e6f",
    "files/bin/host-services-runner.mjs": "a075c7faa3f528019a66dbbdeaf105fe7c8a8b4415b3541693c55655456d5037",
    "files/bin/stage-tool.mjs": "600b036a6514e7ff1d23d3e159966b0b7736233b9d87417c7fa68a42c9549872",
    "files/packages/service-tls.mjs": "d976c794992a59142115119a4895be325ee256d3182feec277b640a07f5388ff",
    "files/packages/service-tls.package.json": "968f411382ee74f6a8bfdb4fe7a61d79e8e819c0a4165b31cac6f1d7f97fde8c",
}
OPT = r"C:\Program Files\Enclave\host-services\hs2"
ROOT = r"C:\ProgramData\Enclave\host-services\hs2"
STAGING = r"C:\ProgramData\Enclave\staging"
PS = r"(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')"
OUT = HERE / "root-g4"
RUNID_RE = r"^[0-9]{14}-[0-9a-f]{8}$"
FRESH_S = 1800
HELPER_SECS = {"Upgrade": 2400, "Revert": 2400, "Recover": 600}  # helper worst case ~1950 s (stop 150 + check 150 + start 750, then stop 150 + start 750)

def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def now(): return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def verify_local():
    bad = [str(p) for p, h in (TRANSPORT, HELPER) if sha(p) != h]
    bad += [k for k, h in BUNDLE_FILES.items() if sha(BUNDLE / k) != h]
    if bad: raise SystemExit(f"local pins differ: {bad}")
    sp = importlib.util.spec_from_file_location("transport", TRANSPORT[0]); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
    return m, json.loads((BUNDLE / "upgrade-manifest.json").read_text())

UTF8 = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"
FACTS = UTF8 + (
    r"$o='OPTX';$r='ROOTX';$f=[ordered]@{};foreach($p in 'RELS'.Split('|')){$f[$p]=FileSha (Join-Path $o ($p -replace '/','\'))};"
    r"$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2' -ErrorAction SilentlyContinue;$x='absent';"
    r"if($t){$x=-join([Security.Cryptography.SHA256]::Create().ComputeHash((New-Object Text.UTF8Encoding $false).GetBytes([string](Export-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2')))|ForEach-Object{$_.ToString('x2')})};"
    r"$l=$r+'\upgrades\active.lock';$k=$null;if(Test-Path -LiteralPath $l){$k=[string][IO.File]::ReadAllText($l);if($k.Length -gt 40){$k=$k.Substring(0,40)}};"
    r"$j=$null;$id='RUNX';if($id){$j=[ordered]@{};foreach($n in 'journal','revert-journal'){$q=$r+'\upgrades\'+$id+'\'+$n+'.json';$v=$null;"
    r"if(Test-Path -LiteralPath $q){try{$y=[IO.File]::ReadAllText($q)|ConvertFrom-Json;$v=[ordered]@{manifest=[string]$y.manifest;phase=[string]$y.phase;receiptNew=[string]$y.receiptNew}}catch{$v='unreadable'}};$j[$n]=$v}};"
    r"[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');files=$f;config=FileSha ($r+'\config\host-services.json');receipt=FileSha ($r+'\config\install-receipt.txt');"
    r"taskState=$(if($t){[string]$t.State}else{'absent'});taskXmlSha=$x;lock=$k;journal=$j;"
    r"helpers=@(Get-CimInstance Win32_Process|Where-Object{([string]$_.CommandLine) -like '*hs2-upgrade.ps1*'}).Count;"
    r"freeMiB=[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024);freeDiskMiB=[math]::Floor((Get-PSDrive C).Free/1MB)}|ConvertTo-Json -Depth 4 -Compress")
# the INSTALLED health.ps1 (pinned), WaitSeconds 0: only "PASS|FAIL  <check name>" kept, the detail column is dropped
HEALTH = UTF8 + (
    r"$hp='OPTX\windows\health.ps1';if((FileSha $hp) -ne 'HSX'){[ordered]@{exit=$null;error='health.ps1 is not pinned'}|ConvertTo-Json -Compress}"
    r"else{$ErrorActionPreference='Continue';$z=@(& PSX -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $hp 2>&1);$rc=$LASTEXITCODE;"
    r"[ordered]@{exit=$rc;checks=@($z|ForEach-Object{[string]$_}|Where-Object{$_ -match '^(PASS|FAIL)  '}|ForEach-Object{($_ -split '  ')[0..1] -join ' '})}|ConvertTo-Json -Depth 3 -Compress}")
MKSTAGE = r"$d='DX';if(Test-Path -LiteralPath $d){throw 'stage exists'};$null=New-Item -ItemType Directory -Path $d;foreach($s in 'bundle\config','bundle\files\bin','bundle\files\packages'){$null=New-Item -ItemType Directory -Path (Join-Path $d $s)};[ordered]@{created=$d}|ConvertTo-Json -Compress"
STAGED = (r"$d='DX';$a=[ordered]@{};foreach($p in 'SRELS'.Split('|')){$a[$p]=FileSha (Join-Path $d $p)};$t=$null;$e=$null;"
          r"[void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'hs2-upgrade.ps1'),[ref]$t,[ref]$e);"
          r"[ordered]@{files=$a;count=@(Get-ChildItem -LiteralPath $d -Recurse -Force -File).Count;parseErrors=@($e|ForEach-Object{$_.Message})}|ConvertTo-Json -Depth 4 -Compress")
# re-verify the staged helper + manifest right before; a drift answers "started=false" (the helper did not run)
RUN = UTF8 + (
    r"$d='DX';$h=Join-Path $d 'hs2-upgrade.ps1';$b=Join-Path $d 'bundle';"
    r"if((FileSha $h) -ne 'HX' -or (FileSha (Join-Path $b 'upgrade-manifest.json')) -ne 'MX'){[ordered]@{started=$false;error='staged drift'}|ConvertTo-Json -Compress}"
    r"else{$ErrorActionPreference='Continue';$z=@(& PSX -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $h -Bundle $b -ManifestSha256 'MX' -Mode MODEX ARGSX 2>&1);$rc=$LASTEXITCODE;"
    r"$s=@($z|ForEach-Object{[string]$_});$res=@($s|Where-Object{$_.StartsWith('RESULT ')})|Select-Object -Last 1;$oth=[string]::Join([string][char]10,@($s|Where-Object{-not $_.StartsWith('RESULT ')}));"
    r"if($oth.Length -gt 1500){$oth=$oth.Substring($oth.Length-1500)};[ordered]@{started=$true;exit=$rc;result=$(if($res){$res.Substring(7)}else{$null});other=$oth}|ConvertTo-Json -Compress}")

def rels(man): return "|".join([r["path"] for r in man["replace"]] + [a["path"] for a in man["add"]] + [u["path"] for u in man["unchanged"]])
def srels(): return "|".join(["hs2-upgrade.ps1"] + ["bundle\\" + k.replace("/", "\\") for k in BUNDLE_FILES])
def facts_text(man, run_id=""):
    return FACTS.replace("OPTX", OPT).replace("ROOTX", ROOT).replace("RELS", rels(man)).replace("RUNX", run_id)
def health_text(man): return HEALTH.replace("OPTX", OPT).replace("HSX", man["scripts"]["windows/health.ps1"]).replace("PSX", PS)
def run_text(stage, mode, extra):
    return RUN.replace("DX", stage).replace("HX", HELPER[1]).replace("MX", MSHA).replace("MODEX", mode).replace("ARGSX", extra).replace("PSX", PS)
def helper_args(mode, arg):
    return {"Upgrade": "-HealthWaitSeconds 600 -StopTimeoutSeconds 120", "Revert": f"-RevertRunId '{arg}' -HealthWaitSeconds 600 -StopTimeoutSeconds 120",
            "Recover": "-StopTimeoutSeconds 120"}[mode]

def evidence(m, man, run_id=""):
    return {"facts": m.ps(facts_text(man, run_id), 90), "health": m.ps(health_text(man), 240)}

def gate(ev, man, kind, run_id=""):
    """kind upgrade|revert|recover|upgraded -> list of failures (empty = pass). 'upgraded' is the post-success expectation."""
    f, bad = ev.get("facts", {}), []
    if "error" in f: return [f"facts: {f.get('error')}"]
    # an orphaned helper (ssh lost / wrapper killed: the remote child survives) still holds the lock: never act beside it
    if f.get("helpers") != 0: return [f"{f.get('helpers')} hs2-upgrade.ps1 process(es) running: wait, then a new read-only preflight"]
    if kind == "recover": return [] if f.get("lock") is not None else ["no active.lock to recover"]
    want = "old" if kind == "upgrade" else "new"
    files = f.get("files", {})
    bad += [f"{r['path']} {files.get(r['path'])} != {want} {r[want]}" for r in man["replace"] if files.get(r["path"]) != r[want]]
    bad += [f"{u['path']} {files.get(u['path'])} != unchanged" for u in man["unchanged"] if files.get(u["path"]) != u["sha"]]
    # G3: added files are ABSENT before the upgrade and the pinned new sha after it (FileSha answers 'absent')
    bad += [f"{a['path']} {files.get(a['path'])} != {'absent' if want == 'old' else a['new']}" for a in man["add"] if files.get(a["path"]) != ("absent" if want == "old" else a["new"])]
    if f.get("config") != man["config"][want]: bad.append(f"config {f.get('config')} != {want}")
    if f.get("lock") is not None: bad.append(f"active.lock present ({f.get('lock')!r})")
    if f.get("taskState") != "Running": bad.append(f"task {f.get('taskState')}")
    if kind == "upgrade":
        if f.get("receipt") != man["receipt"]["old"]: bad.append(f"receipt {f.get('receipt')} != old")
        if (f.get("freeMiB") or 0) < 2048: bad.append(f"freeMiB {f.get('freeMiB')}")
    else:
        j = (f.get("journal") or {}).get("journal")
        if not isinstance(j, dict) or j.get("manifest") != MSHA or j.get("phase") != "complete": bad.append(f"run {run_id} journal {j!r} is not a completed G4 upgrade")
        elif f.get("receipt") != j.get("receiptNew"): bad.append("receipt is not that run's receiptNew")
    if kind in ("upgrade", "upgraded") and ev.get("health", {}).get("exit") != 0: bad.append(f"health {ev.get('health')}")
    return bad

def save(name, obj):
    OUT.mkdir(exist_ok=True); p = OUT / name
    with open(p, "x") as fh: json.dump(obj, fh, indent=1); fh.flush(); os.fsync(fh.fileno())
    print("receipt:", p); return p

def load_receipt(path, what):
    o = json.loads(pathlib.Path(path).read_text())
    if o.get("what") != what: raise SystemExit(f"{path} is not a {what} receipt")
    return o

def main(argv):
    a = argparse.ArgumentParser(); x = a.add_mutually_exclusive_group()
    x.add_argument("--stage", action="store_true"); x.add_argument("--execute", action="store_true")
    x.add_argument("--revert", metavar="RUNID"); x.add_argument("--recover", metavar="LOCKID"); x.add_argument("--selfcheck", action="store_true")
    a.add_argument("--run-id", default=""); a.add_argument("--preflight"); a.add_argument("--stage-receipt")
    a.add_argument("--manifest-sha"); a.add_argument("--helper-sha")
    o = a.parse_args(argv)
    for r in (o.run_id, o.revert):
        if r and not re.match(RUNID_RE, r): raise SystemExit(f"bad run id {r!r}")
    m, man = verify_local()
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())

    if o.selfcheck:  # local only: nothing is sent
        texts = {"facts": facts_text(man, "20261021000000-0123abcd"), "health": health_text(man),
                 "mkstage": MKSTAGE.replace("DX", STAGING + r"\hs2up-g4-0123456789ab"),
                 "staged": STAGED.replace("DX", STAGING + r"\hs2up-g4-0123456789ab").replace("SRELS", srels())}
        for md, arg in (("Upgrade", ""), ("Revert", "20261021000000-0123abcd"), ("Recover", "")):
            texts["run-" + md] = run_text(STAGING + r"\hs2up-g4-0123456789ab", md, helper_args(md, arg))
        lens = {k: len(base64.b64encode((m.HEAD.replace("SECS", "2400") + t).encode("utf-16-le"))) for k, t in texts.items()}
        left = {k: [p for p in ("OPTX", "ROOTX", "RELS", "RUNX", "HSX", "PSX", "DX", "HX", "MX", "MODEX", "ARGSX") if p in t] for k, t in texts.items()}
        print(json.dumps({"localPins": "ok", "encodedLengths": lens, "limit": 7900, "placeholdersLeft": left}, indent=1))
        return 0 if all(v <= 7900 for v in lens.values()) and not any(left.values()) else 4

    if not (o.stage or o.execute or o.revert or o.recover):  # default: read-only preflight
        ev = evidence(m, man, o.run_id)
        g = {"upgrade": gate(ev, man, "upgrade")}
        if o.run_id: g["revert"] = gate(ev, man, "revert", o.run_id)
        rec = {"what": "preflight", "at": now(), "runId": o.run_id, "evidence": ev, "gates": g}
        print(json.dumps(rec, indent=1)); save(f"preflight-{ts}.json", rec)
        return 0 if not g["upgrade"] else 1

    pre = load_receipt(o.preflight, "preflight") if o.preflight else None
    if pre is None: raise SystemExit("--preflight <receipt> is required")
    age = time.time() - calendar.timegm(time.strptime(pre["at"], "%Y-%m-%dT%H:%M:%SZ"))
    if age > FRESH_S: raise SystemExit(f"preflight receipt is {int(age)} s old (> {FRESH_S}): run a new preflight")

    if o.stage:
        if pre["gates"]["upgrade"]: raise SystemExit(f"preflight refused: {pre['gates']['upgrade']}")
        d = STAGING + "\\hs2up-g4-" + uuid.uuid4().hex[:12]
        rec = {"what": "stage", "at": now(), "stage": d, "preflight": str(o.preflight)}
        rec["mkdir"] = m.ps(MKSTAGE.replace("DX", d), 60)
        if rec["mkdir"].get("created") != d: save(f"stage-{ts}.json", rec); raise SystemExit(f"stage dir not created: {rec['mkdir']}")
        up = [(HELPER[0], "hs2-upgrade.ps1")] + [(BUNDLE / k, "bundle/" + k) for k in BUNDLE_FILES]
        for src, rel in up:
            q = subprocess.run(["timeout", "180", "scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", str(src),
                                "minipc:/" + d.replace("\\", "/") + "/" + rel], capture_output=True, text=True)
            if q.returncode != 0: rec["uploadFailed"] = {"file": rel, "rc": q.returncode, "stderr": q.stderr[-300:]}; break
        rec["verify"] = v = m.ps(STAGED.replace("DX", d).replace("SRELS", srels()), 90)
        want = {"hs2-upgrade.ps1": HELPER[1], **{"bundle\\" + k.replace("/", "\\"): h for k, h in BUNDLE_FILES.items()}}
        rec["ok"] = ("uploadFailed" not in rec and "error" not in v and v.get("files") == want and v.get("count") == len(want)
                     and v.get("parseErrors") == [])
        print(json.dumps(rec, indent=1)); save(f"stage-{ts}.json", rec)
        return 0 if rec["ok"] else 4

    # ---- execute / revert / recover: root-supplied exact pins + prior receipts, attempt recorded BEFORE the remote call
    if o.manifest_sha != MSHA or o.helper_sha != HELPER[1]: raise SystemExit("--manifest-sha/--helper-sha must be the exact reviewed pins")
    st = load_receipt(o.stage_receipt, "stage") if o.stage_receipt else None
    if not st or not st.get("ok"): raise SystemExit("--stage-receipt <ok stage receipt> is required")
    mode, kind, arg = (("Upgrade", "upgrade", "") if o.execute else ("Revert", "revert", o.revert) if o.revert else ("Recover", "recover", o.recover))
    if kind == "revert" and pre.get("runId") != arg: raise SystemExit("the preflight was not taken with --run-id " + arg)
    if kind != "recover" and pre["gates"].get(kind) != []: raise SystemExit(f"preflight refused: {pre['gates'].get(kind)}")
    fresh = evidence(m, man, arg if kind == "revert" else "")
    bad = gate(fresh, man, kind, arg)
    pf, ff = pre["evidence"]["facts"], fresh["facts"]
    if kind != "recover" and ff.get("taskXmlSha") != pf.get("taskXmlSha"): bad.append("task XML changed since the preflight receipt")
    if kind == "recover" and ((ff.get("lock") or "").strip() or "EMPTY") != arg: bad.append(f"lock is {ff.get('lock')!r}, not {arg}")
    if bad:
        print(json.dumps({"freshPreflight": fresh, "refused": bad}, indent=1)); print("REFUSED before any change"); return 4
    name = f"attempt-{kind}" + (f"-{arg}" if arg else "") + ".json"
    attempt = {"what": "attempt", "at": now(), "mode": mode, "arg": arg, "stage": st["stage"], "manifest": MSHA, "helper": HELPER[1],
               "preflightReceipt": [str(o.preflight), sha(o.preflight)], "stageReceipt": [str(o.stage_receipt), sha(o.stage_receipt)], "freshPreflight": fresh}
    try: save(name, attempt)
    except FileExistsError:
        print(f"REFUSED: {OUT / name} exists. An attempt is never retried automatically; root inspects it and the host, then moves it aside."); return 4
    fd = os.open(OUT, os.O_RDONLY); os.fsync(fd); os.close(fd)
    res = {"what": "result", "attempt": name}
    try:
        res["helper"] = h = m.ps(run_text(st["stage"], mode, helper_args(mode, arg)), HELPER_SECS[mode])
        try: res["helperResult"] = json.loads(h["result"]) if h.get("result") else None
        except Exception: res["helperResult"] = None
    finally:
        rid = (res.get("helperResult") or {}).get("runId") or (arg if kind == "revert" else "")
        res["post"] = post = evidence(m, man, rid if re.match(RUNID_RE, str(rid)) else "")
        res["at"] = now(); save(f"result-{kind}-{ts}.json", res)
    hr, ex = res.get("helperResult") or {}, h.get("exit")
    if h.get("started") is False: verdict, rc = "helper NOT started (staged drift): no change by this attempt", 1
    elif "error" in h or ex not in (0, 1, 2, 3) or not hr:
        live = post.get("facts", {}).get("helpers")
        verdict, rc = (f"UNKNOWN: no helper RESULT; hs2-upgrade.ps1 still running: {live}. ROOT: do not retry; if not 0, wait for it to end "
                       "(it bounds itself, ~1950 s) and take a new read-only preflight; only then consider --recover"), 3
    elif ex == 0:
        g = gate(post, man, "upgraded", rid) if kind == "upgrade" else gate(post, man, "upgrade")  # revert/recover: back to the old pins
        g = [b for b in g if not b.startswith("freeMiB") and not (kind == "recover" and b.startswith(("task ", "health ")))]  # Recover leaves the task stopped
        if kind != "recover" and post.get("facts", {}).get("taskXmlSha") != ff.get("taskXmlSha"): g.append("task XML changed")
        verdict, rc = (("DONE and post evidence verified", 0) if not g else (f"helper exit 0 but post evidence differs: {g}. ROOT", 3))
    elif ex == 1: verdict, rc = "REFUSED by the helper before any change", 1
    elif ex == 2: verdict, rc = "FAILED; the helper restored the old files and the old code is healthy (or was not running)", 2
    else: verdict, rc = "HELPER exit 3: ROOT (lock kept). Next is root's explicit decision (--recover / inspection)", 3
    print(json.dumps(res, indent=1)); print(verdict, f"(runId {rid or '?'})")
    return rc

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
