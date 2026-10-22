#!/usr/bin/env python3
"""Native validation that Win32_ProcessStartTrace.Sid is the STARTED PROCESS's token user, not the event provider's
context (MS docs only say "security identifier of the process"; root requires a native check before G1 relies on it).

A KNOWN NON-SYSTEM NEGATIVE: in ONE root SSH session (non-SYSTEM admin user), subscribe to the trace, start ONE own child
`powershell -NoProfile -Command Start-Sleep -Seconds 2`, read that child's Win32_Process.GetOwner while
it lives, and take the trace event whose ProcessID = child pid and ParentProcessID = this session's PID.
VALID only if the event SID equals this session's user SID (not S-1-5-18), the child's GetOwner is the same account,
and the event's TIME_CREATED/SessionID match the child's CreationDate/SessionId.
If the SID came out S-1-5-18 for this user child, the field reflects the provider and G1 must NOT use it.

No task, service, file, account or config is created or changed. The subscription is temporary, bound to the session,
and unregistered in `finally`. The child exits by itself; only if it is still alive after 8 s is THAT child (our own
handle) killed. The transport's watchdog bounds the session.

ROOT runs it (queue 256), after review:
  trace_validate.py plan                      local: writes script.ps1, prints sha + encoded size (<= 7900)
  trace_validate.py parse --script-sha S      read-only remote: minipc's parser on the exact text
  trace_validate.py run   --script-sha S      the one validation session -> evidence/result-<UTC>.json (+ verdict)
  trace_validate.py check FILE                local: re-evaluate a result file
"""
import argparse, base64, datetime, hashlib, importlib.util, json, os, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent
TRANSPORT = HERE.parent / "nucbox-tls-20261021/root-activate-reviewed.py"
TRANSPORT_SHA = "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f"
LIMIT, SECS = 7900, 60
WRAP = ";$j=$o|ConvertTo-Json -Depth 6 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress"
SYSTEM = "S-1-5-18"

SCRIPT = (
    "$G1='tv';$I=[Security.Principal.WindowsIdentity]::GetCurrent();"
    "$o=[ordered]@{me=$I.User.Value;meName=$I.Name;mePid=$PID;on=$null;child=$null;owner=$null;exited=$null;starts=@();errs=@();cleanup=$null};$ch=$null;"
    "try{"
    "try{Register-CimIndicationEvent -Query \"SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName='powershell.exe'\" -SourceIdentifier G1V;$o.on=$true}"
    "catch{$o.on=[string]$_.FullyQualifiedErrorId};Start-Sleep -Milliseconds 500;"
    "$ch=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 2' -WindowStyle Hidden -PassThru;"
    "$cp=Get-CimInstance Win32_Process -Filter \"ProcessId=$($ch.Id)\" -OperationTimeoutSec 5;"
    "$o.child=[ordered]@{pid=$ch.Id;ppid=[int]$cp.ParentProcessId;session=[int]$cp.SessionId;created=$cp.CreationDate.ToUniversalTime().ToString('o')};"
    "try{$w=Invoke-CimMethod -InputObject $cp -MethodName GetOwner -OperationTimeoutSec 5;"
    "$o.owner=[ordered]@{rc=[int]$w.ReturnValue;name=[string]$w.Domain+'\\'+[string]$w.User;alive=-not $ch.HasExited}}catch{$o.errs+='owner:'+$_.FullyQualifiedErrorId};"
    "$o.exited=$ch.WaitForExit(8000);Start-Sleep -Seconds 2;"
    "foreach($e in @(Get-Event -SourceIdentifier G1V -ErrorAction SilentlyContinue)){$n=$e.SourceEventArgs.NewEvent;if([int]$n.ParentProcessID -ne $PID){continue};"
    "try{$o.starts+=[ordered]@{pid=[int]$n.ProcessID;ppid=[int]$n.ParentProcessID;session=[int]$n.SessionID;"
    "created=[DateTime]::FromFileTimeUtc([int64]$n.TIME_CREATED).ToString('o');sid=(New-Object Security.Principal.SecurityIdentifier([byte[]]$n.Sid,0)).Value}}"
    "catch{$o.errs+='event:'+$_.FullyQualifiedErrorId}}"
    "}catch{$o.errs+='main:'+$_.FullyQualifiedErrorId}"
    "finally{$cl=[ordered]@{};"
    "try{Unregister-Event -SourceIdentifier G1V -ErrorAction Stop;$cl.unregistered=$true}catch{$cl.unregistered=[string]$_.FullyQualifiedErrorId};"
    "try{Get-Event -SourceIdentifier G1V -ErrorAction SilentlyContinue|Remove-Event}catch{};"
    "$cl.subscribers=@(Get-EventSubscriber -SourceIdentifier G1V -ErrorAction SilentlyContinue).Count;"
    "if($ch -and -not $ch.HasExited){try{$ch.Kill();$cl.childKilled=$true}catch{$cl.childKilled=[string]$_.FullyQualifiedErrorId}}else{$cl.childKilled=$false};"
    "$o.cleanup=$cl}")


def sha(b): return hashlib.sha256(b if isinstance(b, bytes) else b.encode()).hexdigest()
def utc(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def ts(s):
    try: return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception: return None


def transport():
    if sha(TRANSPORT.read_bytes()) != TRANSPORT_SHA: sys.exit("transport is not the pinned c50aac8e: refusing")
    s = importlib.util.spec_from_file_location("t", TRANSPORT); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m


def encoded(m, text): return len(base64.b64encode((m.HEAD.replace("SECS", str(SECS)) + text + WRAP).encode("utf-16-le")))
def parse_text(): return "$G1='parse';$t='" + SCRIPT.replace("'", "''") + "';$e=$null;$tk=$null;[void][Management.Automation.Language.Parser]::ParseInput($t,[ref]$tk,[ref]$e);$o=[ordered]@{errors=@($e|?{$_}|%{$_.Message})}"


def evaluate(r):
    """VALID = the trace SID is the child's real (non-SYSTEM) token user, cross-checked three ways"""
    starts = [s for s in (r.get("starts") or []) if s.get("pid") == (r.get("child") or {}).get("pid")]
    ev = starts[0] if len(starts) == 1 else {}
    ch, ow, cl = r.get("child") or {}, r.get("owner") or {}, r.get("cleanup") or {}
    tc, cc = ts(ev.get("created")), ts(ch.get("created"))
    checks = {
        "subscribed": r.get("on") is True,
        "oneEventForChild": len(starts) == 1,
        "eventParentIsSession": ev.get("ppid") == r.get("mePid") == ch.get("ppid"),
        "eventSessionMatches": ev.get("session") is not None and ev.get("session") == ch.get("session"),
        "eventTimeMatches": tc is not None and cc is not None and abs(tc - cc) <= 2.0,
        "sidIsSessionUser": bool(ev.get("sid")) and ev.get("sid") == r.get("me"),
        "sidIsNotSystem": bool(ev.get("sid")) and ev.get("sid") != SYSTEM and r.get("me") != SYSTEM,
        "getOwnerAgrees": ow.get("rc") == 0 and str(ow.get("name", "")).lower() == str(r.get("meName", "")).lower(),
        "noErrors": not r.get("errs"),
        "cleanup": cl.get("unregistered") is True and cl.get("subscribers") == 0 and cl.get("childKilled") is False and r.get("exited") is True,
    }
    return {"VALID": all(checks.values()), "checks": checks, "eventSid": ev.get("sid"), "sessionSid": r.get("me")}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("plan")
    for n in ("parse", "run"): sp.add_parser(n).add_argument("--script-sha", required=True)
    sp.add_parser("check").add_argument("file")
    a = ap.parse_args()
    if a.cmd == "check":
        print(json.dumps(evaluate(json.loads(pathlib.Path(a.file).read_text()).get("result") or {}), indent=1)); return
    m = transport()
    if a.cmd == "plan":
        (HERE / "script.ps1").write_text(SCRIPT)
        out = {"scriptSha": sha(SCRIPT), "encoded": encoded(m, SCRIPT), "parseEncoded": encoded(m, parse_text()), "limit": LIMIT}
        print(json.dumps(out, indent=1))
        if max(out["encoded"], out["parseEncoded"]) > LIMIT: sys.exit("over the transport limit")
        return
    if a.script_sha != sha(SCRIPT): sys.exit("the script is not the reviewed sha: refusing")
    ev = HERE / "evidence"; ev.mkdir(exist_ok=True); stamp = utc().replace(":", "")
    text = SCRIPT if a.cmd == "run" else parse_text()
    with open(ev / "journal.jsonl", "a") as f:
        f.write(json.dumps({"at": utc(), "phase": "attempt", "step": a.cmd, "scriptSha": sha(text)}) + "\n"); f.flush(); os.fsync(f.fileno())
    try: r = m.ps(text + WRAP, secs=SECS)
    except SystemExit as e: r = {"error": f"transport refused: {e}"}
    if r.get("payload"): r = json.loads(base64.b64decode(r["payload"]).decode())
    with open(ev / "journal.jsonl", "a") as f:
        f.write(json.dumps({"at": utc(), "phase": "result", "step": a.cmd, "ok": "error" not in r}) + "\n"); f.flush(); os.fsync(f.fileno())
    out = {"at": utc(), "step": a.cmd, "scriptSha": a.script_sha, "result": r}
    if a.cmd == "run": out["verdict"] = evaluate(r)
    p = ev / f"{a.cmd}-{stamp}.json"; p.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: out[k] for k in out if k != "result"} | ({"errors": r.get("errors")} if a.cmd == "parse" else {}), indent=1)); print("evidence", p)
    if a.cmd == "parse" and (r.get("error") or r.get("errors")): sys.exit(1)
    if a.cmd == "run" and not out["verdict"]["VALID"]: sys.exit(2)


if __name__ == "__main__":
    main()
