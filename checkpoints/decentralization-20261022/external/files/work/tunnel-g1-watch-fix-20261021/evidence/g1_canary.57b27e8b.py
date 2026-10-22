#!/usr/bin/env python3
"""G1 CANARY: one disposable native proof that Windows Task Scheduler runs the tunnel controller's EXACT launcher as
SYSTEM - by a real -Once trigger AND by Start-ScheduledTask - and that a post-registration params.json tamper is refused
by the launcher BEFORE the receiver runs. Prepared by Claude 7d for root; its author never executed it remotely.

ROOT RUNS IT, through the queue, in this order (each step needs the previous one's output; nothing picks "latest"):
  g1_canary.py plan  --manifest M.json [--offset-min 2]   local only: pins -> frozen copies, every script built, sizes
  g1_canary.py parse --run R --plan-sha S                 READ-ONLY remote: minipc's parser over every built script
  g1_canary.py run   --run R --plan-sha S                 the canary (below); cleanup always runs in `finally`
  g1_canary.py cleanup --run R                            re-run the journaled cleanup (idempotent; only what R made)
  g1_canary.py self-test                                  local fake minipc (no network)

M.json (root writes it; explicit paths + sha256, no defaults):
  {"controller": {"path": ".../tunnel_install.py", "sha256": "..."},
   "receiver":   {"path": ".../minipc/tunnel-receiver.ps1", "sha256": "..."},
   "transport":  {"path": ".../nucbox-tls-20261021/root-activate-reviewed.py", "sha256": "..."}}

What `run` does on minipc (all under ONE new dir STAGE_ROOT\\tunnel-<R>; tasks EnclaveTunnelCanary-<R><role>):
  0. read-only preflight: staging-root chain (C:\\, \\ProgramData, \\Enclave, \\staging) owner/reparse/ACEs. A holder other
     than SYSTEM/Administrators/TrustedInstaller of DELETE_CHILD/DELETE/WRITE_DAC/WRITE_OWNER/GENERIC_ALL on any of them
     (inherit-only ACEs excluded), another owner, or a reparse point -> REFUSED, nothing made. There is no override.
  1. the controller's mkdir_protected (outer + one dir per role), scp_to, seal_and_prove; an independent stage proof.
  2. role n: register_task(Once +N min) -> stored definition checked -> params.json rewritten (still sandbox) -> the
     launcher must refuse "hash params.json", exit 9, and the receiver must never write a receipt.
     role o: register_task(Once +N min); NEVER started by us: only the trigger can run it.
     role s: register_task(no trigger) -> start_task (the apply/rollback path).
  3. a read-only watcher (100 ms) records the PID/start/owner/parent of exactly these three launcher processes (matched by
     the sha256 of their -EncodedCommand; no other process's command line is ever recorded); then Task Scheduler's own
     LastRunTime/LastTaskResult, the receipts, their owners, and the Operational event log if it is enabled.
  4. cleanup (controller-side, after terminal receipts; nothing unregisters itself): wait for not-Running, then
     drop_task each task THIS run registered, remove_dir the outer dir THIS run created, verify both gone. A task still
     Running at the deadline gets Stop-ScheduledTask by its exact name; no process is ever killed.
Params are sandbox=true with sandboxRoot = the outer dir; mode is ONLY preflight: no account, key, sshd_config, service,
restart, apply or rollback, and the original VM tunnels are not touched.
"""
import argparse, base64, datetime, hashlib, importlib.util, inspect, json, os, pathlib, re, secrets, shutil, sys, threading, time

HERE = pathlib.Path(__file__).resolve().parent
RUNS = pathlib.Path(os.environ.get("G1_RUNS", HERE / "runs"))
LIMIT = 7900                                    # the reviewed transport's encoded-step limit (cmd.exe 8191)
PS_EXE = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
TI = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
TRUSTED = ("S-1-5-18", "S-1-5-32-544", TI)
CHAIN_MASK = 0x100D0040     # DELETE_CHILD DELETE WRITE_DAC WRITE_OWNER GENERIC_ALL: can move/rename the stage (= the
                            # controller's ANC / the receiver's AncestorProblems; GENERIC_WRITE on a dir grants no delete)
WRITE_MASK = 0x500D0156     # the controller's own write mask, re-checked independently on the stage
ROLES = {"n": "negative: params.json tampered after registration (Once trigger)",
         "o": "positive: Once trigger (the guard's path)",
         "s": "positive: no trigger + Start-ScheduledTask (the apply/rollback path)"}
API = {"STAGE_ROOT": None, "STAGE_WIN": None, "WINUSER": None, "sha": ["b"], "ps": ["script", "secs"],
       "launcher": ["d", "mode", "hashes"], "task_args": ["d", "mode", "hashes"],
       "register_task": ["name", "mode", "d", "at_expr", "hashes"], "start_task": ["name"], "drop_task": ["name"],
       "mkdir_protected": ["d"], "scp_to": ["d", "files"], "seal_and_prove": ["d", "names"], "fresh_proof": ["d"],
       "remove_dir": ["d"]}
CLOCK = {"now": time.time, "sleep": time.sleep, "mono": time.monotonic}   # deadlines use mono: a wall-clock step cannot stretch them


def utc(t=None): return datetime.datetime.fromtimestamp(CLOCK["now"]() if t is None else t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def sha(b): return hashlib.sha256(b if isinstance(b, bytes) else b.encode()).hexdigest()
def q(s): return str(s).replace("'", "''")
def parse_utc(s):
    try: return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception: return None


# ------------------------------------------------------------------------------------------------- read-only scripts
# every script starts with $G1='<kind>' (a marker, harmless) and leaves its result in $o for the controller's ps()
def s_real(user):
    """the REAL system the canary must not touch: sshd_config bytes, the tunnel account, its keys file, sshd state + PID"""
    return ("$cf='C:\\ProgramData\\ssh\\sshd_config';$o.real=[ordered]@{cfgSha=$(if(Test-Path -LiteralPath $cf){(Get-FileHash -Algorithm SHA256 -LiteralPath $cf).Hash.ToLower()}else{'absent'});"
            "user=[bool](Get-LocalUser -Name '" + q(user) + "' -ErrorAction SilentlyContinue);keys=(Test-Path -LiteralPath 'C:\\ProgramData\\ssh\\" + q(user) + "_authorized_keys');"
            "sshd=[string](Get-Service sshd).Status;sshdPid=[int](Get-CimInstance Win32_Service -Filter \"Name='sshd'\" -OperationTimeoutSec 10).ProcessId}")


def s_pre(stage_root, outer, prefix, user):
    return ("$G1='pre';$S=[Security.Principal.SecurityIdentifier];$ok=@('" + "','".join(TRUSTED) + "');"
            "$id=[Security.Principal.WindowsIdentity]::GetCurrent();"
            "$o=[ordered]@{utc=[DateTime]::UtcNow.ToString('o');tzMin=[int][TimeZoneInfo]::Local.GetUtcOffset([DateTime]::Now).TotalMinutes;"
            "psv=$PSVersionTable.PSVersion.ToString();schedule=[string](Get-Service Schedule).Status;"
            "elevated=(New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);"
            "outerExists=(Test-Path -LiteralPath '" + q(outer) + "');"
            "clash=@(Get-ScheduledTask -TaskName '" + q(prefix) + "*' -ErrorAction SilentlyContinue).Count;"
            "opLog=$(try{[bool](Get-WinEvent -ListLog 'Microsoft-Windows-TaskScheduler/Operational').IsEnabled}catch{$null});chain=@()};"
            "foreach($p in 'C:\\','C:\\ProgramData','C:\\ProgramData\\Enclave','" + q(stage_root) + "'){$c=[ordered]@{path=$p;exists=(Test-Path -LiteralPath $p)};"
            "if($c.exists){$i=Get-Item -LiteralPath $p -Force;$a=Get-Acl -LiteralPath $p;$c.owner=$a.GetOwner($S).Value;"
            "$c.reparse=[bool]($i.Attributes -band 1024);$c.sddl=$a.Sddl;$c.risky=@();$c.create=@();"
            "foreach($e in $a.GetAccessRules($true,$true,$S)){if($e.AccessControlType -ne 'Allow' -or ($e.PropagationFlags -band 2)){continue};"
            "$w=$e.IdentityReference.Value;$r=[int64][int]$e.FileSystemRights;if($w -in $ok){continue};"
            "if($r -band " + str(CHAIN_MASK) + "){$c.risky+=($w+':0x'+('{0:x}' -f $r))}elseif($r -band 6){$c.create+=$w}}};$o.chain+=$c};" + s_real(user))


def s_stage(paths):
    return ("$G1='stage';$S=[Security.Principal.SecurityIdentifier];$ok='S-1-5-18','S-1-5-32-544';$o=[ordered]@{items=@()};"
            "foreach($p in @('" + "','".join(q(p) for p in paths) + "')){$x=[ordered]@{path=$p;exists=(Test-Path -LiteralPath $p)};"
            "if($x.exists){$i=Get-Item -LiteralPath $p -Force;$a=Get-Acl -LiteralPath $p;$x.owner=$a.GetOwner($S).Value;"
            "$x.reparse=[bool]($i.Attributes -band 1024);$x.protected=$a.AreAccessRulesProtected;$x.sddl=$a.Sddl;$x.write=@();"
            "foreach($e in $a.GetAccessRules($true,$true,$S)){$w=$e.IdentityReference.Value;"
            "if($e.AccessControlType -eq 'Allow' -and ([int64][int]$e.FileSystemRights -band " + str(WRITE_MASK) + ") -and $w -notin $ok){$x.write+=$w}};"
            "if(-not $i.PSIsContainer){$x.sha=(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()}};$o.items+=$x}")


def s_inspect(name):
    return ("$G1='inspect';$n='" + q(name) + "';$k=Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue;$o=[ordered]@{registered=[bool]$k;now=[DateTime]::UtcNow.ToString('o')};"
            "if($k){$i=Get-ScheduledTaskInfo -TaskName $n;$H=[Security.Cryptography.SHA256]::Create();$a=[string]$k.Actions[0].Arguments;"
            "$o.path=[string]$k.TaskPath;$o.state=[string]$k.State;$o.user=[string]$k.Principal.UserId;$o.logon=[string]$k.Principal.LogonType;"
            "$o.level=[string]$k.Principal.RunLevel;$o.group=[string]$k.Principal.GroupId;$o.actions=@($k.Actions).Count;$o.exe=[string]$k.Actions[0].Execute;"
            "$o.argSha=-join($H.ComputeHash([Text.Encoding]::UTF8.GetBytes($a))|%{$_.ToString('x2')});$o.argLen=$a.Length;$o.wd=[string]$k.Actions[0].WorkingDirectory;"
            "$o.triggerCount=@($k.Triggers).Count;$o.triggers=@(@($k.Triggers)|?{$_}|%{[ordered]@{cls=$_.CimClass.CimClassName;startUtc=$(if($_.StartBoundary){([DateTime]::Parse($_.StartBoundary)).ToUniversalTime().ToString('o')}else{$null});enabled=[bool]$_.Enabled}});"
            "$o.limit=[string]$k.Settings.ExecutionTimeLimit;$o.swa=[bool]$k.Settings.StartWhenAvailable;$o.enabled=[bool]$k.Settings.Enabled;"
            "$o.lastRun=$(if($i.LastRunTime){$i.LastRunTime.ToUniversalTime().ToString('o')}else{$null});$o.lastResult=[int64]$i.LastTaskResult;$o.missed=[int]$i.NumberOfMissedRuns;"
            "$o.xmlSha=-join($H.ComputeHash([Text.Encoding]::UTF8.GetBytes([string](Export-ScheduledTask -TaskName $n)))|%{$_.ToString('x2')})}")


def s_tamper(path, new_bytes):
    return ("$G1='tamper';$f='" + q(path) + "';$S=[Security.Principal.SecurityIdentifier];$H=[Security.Cryptography.SHA256]::Create();"
            "$o=[ordered]@{before=-join($H.ComputeHash([IO.File]::ReadAllBytes($f))|%{$_.ToString('x2')})};"
            "[IO.File]::WriteAllBytes($f,[Convert]::FromBase64String('" + base64.b64encode(new_bytes).decode() + "'));"
            "$o.after=-join($H.ComputeHash([IO.File]::ReadAllBytes($f))|%{$_.ToString('x2')});$o.owner=(Get-Acl -LiteralPath $f).GetOwner($S).Value;$o.at=[DateTime]::UtcNow.ToString('o')")


def s_watch(want, seconds):
    """want: {sha256(encoded command): role}. Only processes whose -EncodedCommand hashes to one of these are recorded."""
    return ("$G1='watch';$want=@{" + ";".join(f"'{h}'='{r}'" for h, r in want.items()) + "};$end=(Get-Date).AddSeconds(" + str(int(seconds)) + ");"
            "$H=[Security.Cryptography.SHA256]::Create();$done=@{};"
            "$o=[ordered]@{from=[DateTime]::UtcNow.ToString('o');polls=0;checked=0;hits=@()};$seen=@{};$gone=@{};"
            "while((Get-Date) -lt $end){$o.polls++;"
            "foreach($p in [Diagnostics.Process]::GetProcessesByName('powershell')){$key=[string]$p.Id+':'+$(try{$p.StartTime.Ticks}catch{0});"
            "if($done.ContainsKey($key)){continue};$done[$key]=1;$o.checked++;"
            "$c=Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.Id)\" -OperationTimeoutSec 5 -ErrorAction SilentlyContinue;if(-not $c){continue};"
            "$m=[regex]::Match([string]$c.CommandLine,'-EncodedCommand\\s+(\\S+)');if(-not $m.Success){continue};"
            "$h=-join($H.ComputeHash([Text.Encoding]::ASCII.GetBytes($m.Groups[1].Value))|%{$_.ToString('x2')});if(-not $want.ContainsKey($h)){continue};"
            "$w=$null;try{$w=Invoke-CimMethod -InputObject $c -MethodName GetOwner -OperationTimeoutSec 5}catch{};"
            "$pp=Get-CimInstance Win32_Process -Filter \"ProcessId=$($c.ParentProcessId)\" -OperationTimeoutSec 5 -ErrorAction SilentlyContinue;$seen[$want[$h]]=$p;"
            "$o.hits+=[ordered]@{role=$want[$h];pid=[int]$c.ProcessId;created=$c.CreationDate.ToUniversalTime().ToString('o');session=[int]$c.SessionId;"
            "exe=[string]$c.ExecutablePath;owner=$(if($w -and $w.User){[string]$w.Domain+'\\'+[string]$w.User}else{$null});"
            "parent=[string]$pp.Name;parentSchedule=([string]$pp.CommandLine -match '\\s-s\\s+Schedule(\\s|$)')}};"
            "foreach($r in @($seen.Keys)){try{if($seen[$r].HasExited){$gone[$r]=1}}catch{$gone[$r]=1}};if($gone.Count -ge $want.Count){break};Start-Sleep -Milliseconds 100};"
            "$o.to=[DateTime]::UtcNow.ToString('o')")


def s_collect(name, d):
    rp = ("$x=[ordered]@{owner=(Get-Acl -LiteralPath $f).GetOwner($S).Value;created=(Get-Item -LiteralPath $f).CreationTimeUtc.ToString('o')};")
    return ("$G1='collect';$n='" + q(name) + "';$d='" + q(d) + "';$S=[Security.Principal.SecurityIdentifier];"
            "$k=Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue;$o=[ordered]@{registered=[bool]$k;now=[DateTime]::UtcNow.ToString('o')};"
            "if($k){$i=Get-ScheduledTaskInfo -TaskName $n;$o.state=[string]$k.State;$o.lastRun=$(if($i.LastRunTime){$i.LastRunTime.ToUniversalTime().ToString('o')}else{$null});"
            "$o.lastResult=[int64]$i.LastTaskResult;$o.missed=[int]$i.NumberOfMissedRuns};"
            "$f=Join-Path $d 'receipt-preflight.json';$o.receipt=$null;if(Test-Path -LiteralPath $f){" + rp +
            "$j=Get-Content -Raw -LiteralPath $f|ConvertFrom-Json;$x.decision=[string]$j.decision;$x.mode=[string]$j.mode;$x.runId=[string]$j.runId;"
            "$x.sandbox=[bool]$j.sandbox;$x.at=[string]$j.at;$x.finishedAt=[string]$j.finishedAt;$x.factsSshd=[string]$j.facts.sshd;"
            "$x.factsAllAbsent=(([string]$j.facts.configSha -eq 'absent') -and ([string]$j.facts.keysSha -eq 'absent') -and -not $j.facts.userPresent -and -not $j.facts.backupPresent -and ($null -eq $j.facts.state));$o.receipt=$x};"
            "$f=Join-Path $d 'launcher-refused-preflight.txt';$o.refused=$null;if(Test-Path -LiteralPath $f){" + rp +
            "$x.text=(Get-Content -Raw -LiteralPath $f).Trim();$o.refused=$x};$o.files=@(Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue|%{$_.Name})")


def s_events(prefix, since):
    return ("$G1='events';$L='Microsoft-Windows-TaskScheduler/Operational';$o=[ordered]@{enabled=$(try{[bool](Get-WinEvent -ListLog $L).IsEnabled}catch{$false});events=@()};"
            "if($o.enabled){foreach($e in @(Get-WinEvent -FilterHashtable @{LogName=$L;StartTime=[DateTime]::Parse('" + since + "').ToLocalTime();Id=100,102,107,110,129,200,201} -ErrorAction SilentlyContinue)){"
            "$x=[xml]$e.ToXml();$v=@{};foreach($y in $x.Event.EventData.Data){$v[[string]$y.Name]=[string]$y.'#text'};"
            "if($v['TaskName'] -like '\\" + q(prefix) + "*'){$o.events+=[ordered]@{id=$e.Id;at=$e.TimeCreated.ToUniversalTime().ToString('o');task=$v['TaskName'];"
            "user=$v['UserContext'];pid=$v['ProcessID'];result=$v['ResultCode']}}}}")


def s_stop(name):
    return "$G1='stop';$n='" + q(name) + "';Stop-ScheduledTask -TaskName $n;$o=[ordered]@{state=[string](Get-ScheduledTask -TaskName $n).State}"


def s_verify(prefix, outer, user):
    return ("$G1='verify';$o=[ordered]@{tasks=@(Get-ScheduledTask -TaskName '" + q(prefix) + "*' -ErrorAction SilentlyContinue|%{$_.TaskName});"
            "outer=(Test-Path -LiteralPath '" + q(outer) + "')};" + s_real(user))


def s_parse(script):
    return ("$G1='parse';$t='" + q(script) + "';"
            "$e=$null;$tk=$null;[void][Management.Automation.Language.Parser]::ParseInput($t,[ref]$tk,[ref]$e);$o=[ordered]@{errors=@($e|?{$_}|%{$_.Message})}")


# ------------------------------------------------------------------------------------------------------- the plan
class Canary:
    def __init__(self, run):
        self.dir = RUNS / run; self.run = run
        self.plan = json.loads((self.dir / "PLAN.json").read_text()); self.m = self.tm = None; self.lock = threading.Lock()
        self.seq = len(self.journal())                         # one monotonic journal across plan/parse/run/cleanup

    # ---- frozen sources: the controller is loaded from its frozen copy (5 levels below WORK, as in its own tree) ----
    def load(self):
        src = self.plan["sources"]
        for k, v in src.items():
            if sha((self.dir / v["frozen"]).read_bytes()) != v["sha256"]: sys.exit(f"frozen {k} changed since plan: refusing")
        s = importlib.util.spec_from_file_location("g1ctl", self.dir / src["controller"]["frozen"])
        m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
        if pathlib.Path(src["transport"]["path"]).resolve() != (m.WORK / "nucbox-tls-20261021/root-activate-reviewed.py").resolve():
            sys.exit("the controller would load a different transport than the pinned one: refusing")
        t = importlib.util.spec_from_file_location("t", self.dir / src["transport"]["frozen"])
        tm = importlib.util.module_from_spec(t); t.loader.exec_module(tm)
        m._m = tm                               # the controller's ps() uses exactly the pinned transport bytes
        m.REC = self.dir / "controller-rec"     # never the author's receipts dir (no controller cmd_* is called anyway)
        for name, params in API.items():
            if not hasattr(m, name): sys.exit(f"controller lacks {name}: not the API this canary was reviewed against")
            if params and list(inspect.signature(getattr(m, name)).parameters)[:len(params)] != params:
                sys.exit(f"controller {name} signature changed: refusing")
        self.m, self.tm = m, tm
        return m

    # ---- journal: an attempt line BEFORE every remote call, a result line after; fsync'd ----
    def j(self, phase, step, detail=None):
        with self.lock, open(self.dir / "journal.jsonl", "a") as f:
            self.seq += 1; n = self.seq
            f.write(json.dumps({"seq": n, "at": utc(), "phase": phase, "step": step, "detail": detail}) + "\n"); f.flush(); os.fsync(f.fileno())
        return n

    def journal(self):
        p = self.dir / "journal.jsonl"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def call(self, step, fn, *a, detail=None):
        self.j("attempt", step, detail)
        try: r = fn(*a)
        except SystemExit as e: r = {"error": f"refused before/at transport: {e}"}
        except Exception as e: r = {"error": f"{type(e).__name__}: {e}"}
        r = r if isinstance(r, dict) else {"value": r}
        n = self.j("result", step, r); (self.dir / "receipts").mkdir(exist_ok=True)
        (self.dir / "receipts" / f"{n:03d}-{step}.json").write_text(json.dumps(r, indent=1) + "\n")
        return r

    def ps(self, step, script, secs=60): return self.call(step, lambda: self.m.ps(script, secs=secs), detail={"scriptSha": sha(script)})


def build_scripts(P, m):
    """every script the canary sends, exactly (for sizes, parse and review)"""
    R = P["roles"]; out = {"pre": s_pre(P["stageRoot"], P["outer"], P["prefix"], P["winUser"]),
                           "stage": s_stage([P["outer"]] + [p for r in R.values() for p in (r["dir"], r["dir"] + "\\params.json", r["dir"] + "\\tunnel-receiver.ps1")]),
                           "tamper": s_tamper(R["n"]["dir"] + "\\params.json", base64.b64decode(R["n"]["tamperedB64"])),
                           "watch": s_watch({r["encSha"]: k for k, r in R.items()}, P["watchSec"]),
                           "events": s_events(P["prefix"], "2026-01-01T00:00:00Z"), "verify": s_verify(P["prefix"], P["outer"], P["winUser"])}
    for k, r in R.items():
        out[f"inspect-{k}"] = s_inspect(r["task"]); out[f"collect-{k}"] = s_collect(r["task"], r["dir"]); out[f"stop-{k}"] = s_stop(r["task"])
    return out


def encoded_sizes(m, tm, P, scripts):
    """the exact encoded size of every remote step: the controller's own calls captured at the transport"""
    got, real = [], tm.ps
    tm.ps = lambda text, secs=150: (got.append(len(base64.b64encode((tm.HEAD.replace("SECS", str(secs)) + text).encode("utf-16-le")))), {})[1]
    try:
        sizes = {}
        def size(label, fn): got.clear(); fn(); sizes[label] = max(got) if got else None     # every remote call of the step
        for k, r in P["roles"].items():
            h = {"tunnel-receiver.ps1": r["receiverSha"], "params.json": r["paramsSha"]}
            size(f"register-{k}", lambda: m.register_task(r["task"], "preflight", r["dir"], r["trigger"], h))
            size(f"mkdir-{k}", lambda: m.mkdir_protected(r["dir"])); size(f"seal-{k}", lambda: m.seal_and_prove(r["dir"], ["params.json", "tunnel-receiver.ps1"]))
            size(f"fresh-{k}", lambda: m.fresh_proof(r["dir"])); size(f"start-{k}", lambda: m.start_task(r["task"])); size(f"drop-{k}", lambda: m.drop_task(r["task"]))
        size("mkdir-outer", lambda: m.mkdir_protected(P["outer"])); size("remove-outer", lambda: m.remove_dir(P["outer"]))
        for k, s in scripts.items(): size(k, lambda: m.ps(s, secs=P["watchSec"] + 60 if k == "watch" else 60))
        for k, s in scripts.items(): size(f"parse:{k}", lambda: m.ps(s_parse(s), secs=60))
        # production: the controller's own guard/apply/rollback registration for every RUN length it accepts
        prod = {}
        for n in range(6, 25):
            run = "x" * n; d = m.STAGE_WIN.format(run=run); hh = {"tunnel-receiver.ps1": "0" * 64, "params.json": "0" * 64}; row = {}
            for nm, mode, at in (("Guard", "guard", "(Get-Date).AddMinutes(10)"), ("Apply", "apply", None), ("Rollback", "rollback", None)):
                got.clear(); m.register_task(f"EnclaveTunnel{nm}-{run}", mode, d, at, hh); row[mode] = max(got)
            prod[n] = row
        return sizes, prod
    finally:
        tm.ps = real


def cmd_plan(a):
    man = json.loads(pathlib.Path(a.manifest).read_text())
    if set(man) != {"controller", "receiver", "transport"}: sys.exit("manifest needs exactly controller, receiver, transport")
    for k, v in man.items():
        if not re.fullmatch(r"[0-9a-f]{64}", str(v.get("sha256", ""))) or not os.path.isabs(str(v.get("path", ""))): sys.exit(f"manifest {k}: absolute path + sha256 required")
        if sha(pathlib.Path(v["path"]).read_bytes()) != v["sha256"]: sys.exit(f"manifest {k}: {v['path']} is not {v['sha256']} (never 'latest': re-review and re-pin)")
    if not 2 <= a.offset_min <= 5: sys.exit("--offset-min must be 2..5 (the tamper must land before the trigger; the run must fit one root session)")
    run = "g1" + secrets.token_hex(4)                                       # 10 chars: equivalent production RUN length 12
    d = RUNS / run; (d / "src").mkdir(parents=True)
    src = {}
    for k, v in man.items():   # the controller sits 5 dirs below WORK, as in its own tree (its WORK = HERE.parents[4])
        f = d / "src" / {"controller": "ctl/tunnel_install.py", "receiver": "tunnel-receiver.ps1", "transport": "root-activate-reviewed.py"}[k]
        f.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(v["path"], f); src[k] = {"path": v["path"], "sha256": v["sha256"], "frozen": str(f.relative_to(d))}
    rtext = (d / "src/tunnel-receiver.ps1").read_bytes().decode("utf-8-sig")
    if re.search(r"Unregister-ScheduledTask|schtasks", rtext, re.I): shutil.rmtree(d); sys.exit("the receiver unregisters tasks itself: G1 requires controller-side removal only")
    P = {"run": run, "createdAt": utc(), "sources": src, "offsetMin": a.offset_min}
    (d / "PLAN.json").write_text(json.dumps(P))
    c = Canary(run); m = c.load()
    if re.search(r"Unregister-ScheduledTask|schtasks", base64.b64decode(m.launcher("C:\\x", "guard", {"tunnel-receiver.ps1": "0" * 64, "params.json": "0" * 64})).decode("utf-16-le"), re.I):
        shutil.rmtree(d); sys.exit("the launcher unregisters tasks: refusing")
    hz = {"tunnel-receiver.ps1": "0" * 64, "params.json": "0" * 64}
    if re.search(r"ExecutionPolicy", rtext + m.task_args("C:\\x", "preflight", hz) + base64.b64decode(m.launcher("C:\\x", "preflight", hz)).decode("utf-16-le"), re.I):
        shutil.rmtree(d); sys.exit("an execution-policy flag/change is in the task or receiver bytes: refusing")
    outer = m.STAGE_WIN.format(run=run); prefix = f"EnclaveTunnelCanary-{run}"
    rsha = sha((d / "src/tunnel-receiver.ps1").read_bytes()); roles = {}
    for k in ROLES:
        rd = d / "stage" / k; rd.mkdir(parents=True)
        shutil.copyfile(d / "src/tunnel-receiver.ps1", rd / "tunnel-receiver.ps1")
        params = {"runId": run + k, "winUser": m.WINUSER, "sandbox": True, "sandboxRoot": outer, "canary": "G1 preflight only: no key, config or account"}
        pb = json.dumps(params, indent=1).encode(); (rd / "params.json").write_bytes(pb)
        h = {"tunnel-receiver.ps1": rsha, "params.json": sha(pb)}
        r = {"what": ROLES[k], "dir": outer + "\\" + k, "task": prefix + k, "trigger": None if k == "s" else f"(Get-Date).AddMinutes({a.offset_min})",
             "receiverSha": rsha, "paramsSha": sha(pb)}
        r["encSha"] = sha(m.launcher(r["dir"], "preflight", h)); r["taskArgsSha"] = sha(m.task_args(r["dir"], "preflight", h))
        if k == "n":
            tb = json.dumps(dict(params, runId=run + "tampered"), indent=1).encode(); (rd / "params.tampered.json").write_bytes(tb)
            r["tamperedB64"] = base64.b64encode(tb).decode(); r["tamperedSha"] = sha(tb)
        roles[k] = r
    P.update({"stageRoot": m.STAGE_ROOT, "winUser": m.WINUSER, "outer": outer, "prefix": prefix, "roles": roles, "watchSec": a.offset_min * 60 + 60,
              "pollSec": 10, "collectSec": 150, "runningWaitSec": 60, "leadSec": 15})
    (d / "PLAN.json").write_text(json.dumps(P))
    scripts = build_scripts(P, m); sizes, prod = encoded_sizes(m, c.tm, P, scripts)
    over = {k: v for k, v in sizes.items() if v is None or v > LIMIT}
    fits = [n for n, row in prod.items() if max(row.values()) <= LIMIT]
    P.update({"encoded": sizes, "limit": LIMIT, "productionRunLenFits": [min(fits), max(fits)] if fits else None,
              "productionRegisterEncoded": prod, "scriptShas": {k: sha(s) for k, s in scripts.items()}})
    (d / "scripts.json").write_text(json.dumps(scripts, indent=1))
    if over or os.environ.get("G1_SIZES"): print(json.dumps(sizes, indent=0))
    if over: shutil.rmtree(d); sys.exit(f"steps over the transport limit {LIMIT}: {over} (nothing kept)")
    body = json.dumps(P, indent=1, sort_keys=True) + "\n"; (d / "PLAN.json").write_text(body)
    print(json.dumps({"run": run, "planSha": sha(body), "outer": outer, "tasks": [r["task"] for r in roles.values()],
                      "maxEncoded": max(sizes.values()), "productionRunLenFits": P["productionRunLenFits"]}, indent=1))


def open_plan(run, plan_sha):
    if not re.fullmatch(r"g1[0-9a-f]{8}", run or ""): sys.exit("--run must be a run id printed by plan")
    p = RUNS / run / "PLAN.json"
    if not p.exists() or sha(p.read_bytes()) != plan_sha: sys.exit("PLAN.json is not the reviewed plan sha: refusing")
    c = Canary(run); m = c.load()
    if sha(json.dumps(build_scripts(c.plan, m), indent=1)) != sha((c.dir / "scripts.json").read_text()): sys.exit("scripts differ from the plan: refusing")
    return c, m


def cmd_parse(a):
    c, m = open_plan(a.run, a.plan_sha); out = {}
    for k, s in json.loads((c.dir / "scripts.json").read_text()).items():
        r = c.ps(f"parse-{k}", s_parse(s)); out[k] = r.get("errors") if "error" not in r else [r["error"]]
    bad = {k: v for k, v in out.items() if v}
    res = {"at": utc(), "planSha": a.plan_sha, "scripts": len(out), "errors": bad, "ok": not bad}
    (c.dir / "PARSE-RESULT.json").write_text(json.dumps(res, indent=1) + "\n"); print(json.dumps(res, indent=1))
    if bad: sys.exit(1)


# ---------------------------------------------------------------------------------------------------------- the run
def chain_ok(pre, P):
    why = []
    if pre.get("error"): return [pre["error"]]
    if not pre.get("elevated"): why.append("the SSH session is not elevated")
    if pre.get("schedule") != "Running": why.append("Schedule service not Running")
    if pre.get("outerExists"): why.append("the outer dir already exists")
    if pre.get("clash"): why.append("a task with this run's prefix already exists")
    ch = pre.get("chain") or []
    if [x.get("path") for x in ch] != ["C:\\", "C:\\ProgramData", "C:\\ProgramData\\Enclave", P["stageRoot"]]: why.append("parent chain not read")
    for x in ch:
        if not x.get("exists"): why.append(f"{x.get('path')} absent")
        elif x.get("reparse"): why.append(f"{x['path']} is a reparse point")
        elif x.get("owner") not in TRUSTED: why.append(f"{x['path']} owner {x.get('owner')}")
        elif x.get("risky"): why.append(f"{x['path']} lets {x['risky']} move/rename/re-ACL the stage")
    return why


def def_ok(ins, r, m):
    """the stored definition, beyond register_task's own argsMatch: exe, principal, one action, the trigger shape"""
    t = ins.get("triggers") or []
    checks = {"registered": ins.get("registered") is True, "argSha": ins.get("argSha") == r["taskArgsSha"], "exe": ins.get("exe") == PS_EXE,
              "user": ins.get("user") == "SYSTEM", "logon": ins.get("logon") == "ServiceAccount", "level": ins.get("level") == "Highest",
              "oneAction": ins.get("actions") == 1, "enabled": ins.get("enabled") is True,
              "trigger": (len(t) == 1 and t[0].get("cls") == "MSFT_TaskTimeTrigger" and t[0].get("enabled") is True) if r["trigger"] else len(t) == 0}
    return checks


def run_canary(c, m, ev):
    P = c.plan; R = P["roles"]; ev.update({"planSha": sha((c.dir / "PLAN.json").read_bytes()), "sources": P["sources"]})
    S = json.loads((c.dir / "scripts.json").read_text())                    # exactly the reviewed + parsed texts
    assert S == build_scripts(P, m)
    pre = c.ps("preflight", S["pre"]); ev["preflight"] = pre
    skew = (parse_utc(pre.get("utc")) or CLOCK["now"]()) - CLOCK["now"]()     # minipc clock - this clock (only for waiting)
    why = chain_ok(pre, P)
    if why: ev["refused"] = why; return ev                                  # nothing was made
    for step, d in [("mkdir-outer", P["outer"])] + [(f"mkdir-{k}", r["dir"]) for k, r in R.items()]:
        mk = c.call(step, m.mkdir_protected, d)
        if not mk.get("created"): ev["abort"] = f"{step}: {mk}"; return ev
    for k, r in R.items():
        local = c.dir / "stage" / k
        sc = c.call(f"scp-{k}", m.scp_to, r["dir"], [local / "tunnel-receiver.ps1", local / "params.json"])
        if sc.get("error"): ev["abort"] = f"scp-{k}: {sc['error']}"; return ev
        seal = c.call(f"seal-{k}", m.seal_and_prove, r["dir"], ["params.json", "tunnel-receiver.ps1"])
        files = {n: (v or {}).get("sha") for n, v in (seal.get("files") or {}).items()}
        if seal.get("ancestors") != [] or seal.get("trust") or files != {"params.json": r["paramsSha"], "tunnel-receiver.ps1": r["receiverSha"]}:
            ev["abort"] = f"seal-{k}: staged dir/bytes not proven: {seal}"; return ev
    st = c.ps("stage-proof", S["stage"]); ev["stageBefore"] = st
    if st.get("error") or any(not i.get("exists") or i.get("reparse") or i.get("owner") not in TRUSTED[:2] or i.get("write") for i in st.get("items") or []):
        ev["abort"] = "independent stage proof failed"; return ev
    ev["tasks"] = {}
    for k in ("n", "o", "s"):
        r = R[k]; h = {"tunnel-receiver.ps1": r["receiverSha"], "params.json": r["paramsSha"]}
        reg = c.call(f"register-{k}", m.register_task, r["task"], "preflight", r["dir"], r["trigger"], h, detail={"task": r["task"], "trigger": r["trigger"]})
        ins = c.ps(f"inspect-{k}", S[f"inspect-{k}"])
        chk = def_ok(ins, r, m); ev["tasks"][k] = {"register": reg, "definition": ins, "definitionChecks": chk}
        if not all(chk.values()): ev["abort"] = f"register-{k}: stored definition is not the pinned launcher/principal: {chk}"; return ev
        if not reg.get("argsMatch"):
            if k != "s": ev["abort"] = f"register-{k}: the controller's own argsMatch is false ({reg}): it would stop here"; return ev
            ev["tasks"]["s"]["controllerWouldNotStart"] = True     # exact controller behaviour: an unverified task is never started
        if k == "n":
            tp = c.ps("tamper-n", S["tamper"])
            fp = c.call("fresh-n", m.fresh_proof, r["dir"]); trig = parse_utc(((ins.get("triggers") or [{}])[0]).get("startUtc"))
            ev["tamper"] = {"write": tp, "fresh": fp, "triggerUtc": utc(trig) if trig else None,
                            "valid": (tp.get("before") == r["paramsSha"] and tp.get("after") == r["tamperedSha"] and not fp.get("trust") and fp.get("ancestors") == []
                                      and trig is not None and parse_utc(tp.get("at")) is not None and parse_utc(tp.get("at")) < trig - 5)}
            if not ev["tamper"]["valid"]: ev["abort"] = "the tamper did not land cleanly before the trigger"; return ev
    for k in ("o", "s"):
        fp = c.call(f"fresh-{k}", m.fresh_proof, R[k]["dir"])
        if fp.get("ancestors") != [] or fp.get("trust") or fp.get("files") != {"params.json": R[k]["paramsSha"], "tunnel-receiver.ps1": R[k]["receiverSha"]}:
            ev["abort"] = f"fresh-{k}: the staged bytes changed before execution"; return ev
    trig = max(parse_utc(ev["tasks"][k]["definition"]["triggers"][0]["startUtc"]) for k in ("n", "o"))
    ev["window"] = {"triggerLatestUtc": utc(trig)}
    ev["window"]["watcherCoversUntilLocal"] = utc(CLOCK["now"]() + P["watchSec"]); ev["window"]["triggerLatestLocal"] = utc(trig - skew)
    if trig - skew < CLOCK["now"]() + P["leadSec"]: ev["window"]["late"] = "the triggers may fire before the watcher polls (slow steps)"
    box = {}; ready = threading.Event()
    def watch(): ready.set(); box.update(r=c.ps("watch", S["watch"], secs=P["watchSec"] + 60))
    w = threading.Thread(target=watch); w.start(); ready.wait()
    CLOCK["sleep"](P["leadSec"])          # the watcher's SSH + PowerShell start-up (2-5 s seen) before s may run
    if not ev["tasks"]["s"].get("controllerWouldNotStart"): ev["start"] = c.call("start-s", m.start_task, R["s"]["task"], detail={"task": R["s"]["task"]})
    w.join(); ev["watch"] = box.get("r")
    ev["collect"] = {}
    end = CLOCK["mono"]() + P["collectSec"]
    while True:
        for k, r in R.items(): ev["collect"][k] = c.ps(f"collect-{k}", S[f"collect-{k}"])
        if all(terminal(k, ev["collect"][k]) for k in R if not (k == "s" and ev.get("start") is None)) or CLOCK["mono"]() > end: break
        CLOCK["sleep"](P["pollSec"])
    ev["events"] = c.ps("events", S["events"])
    ev["stageAfter"] = c.ps("stage-proof-after", S["stage"])
    return ev


def terminal(k, col):
    if col.get("error") or col.get("state") == "Running": return False
    return bool(col.get("refused")) if k == "n" else bool((col.get("receipt") or {}).get("decision"))


def cleanup(c, m):
    """only what THIS run's journal shows it made: tasks it attempted to register (their names were proven absent by the
    preflight first), and the outer dir it created. Not-Running first; Stop-ScheduledTask by exact name only if still
    Running after the wait; never a process kill; then verified gone."""
    P = c.plan; J = c.journal(); res = {"tasks": {}}
    pre_ok = any(e["phase"] == "result" and e["step"] == "preflight" and not (e["detail"] or {}).get("clash") and not (e["detail"] or {}).get("error") for e in J)
    regs = [e["detail"]["task"] for e in J if e["phase"] == "attempt" and e["step"].startswith("register-")]
    for name in regs:
        if not pre_ok: res["tasks"][name] = "left: ownership unproven (no clean preflight)"; continue
        end = CLOCK["mono"]() + P["runningWaitSec"]
        while True:
            ins = c.ps("cleanup-inspect", s_inspect(name))
            if ins.get("error") or not ins.get("registered") or ins.get("state") != "Running" or CLOCK["mono"]() > end: break
            CLOCK["sleep"](5)
        if ins.get("error"): res["tasks"][name] = f"unknown: {ins['error']}"; continue
        if not ins.get("registered"): res["tasks"][name] = "absent"; continue
        if ins.get("state") == "Running": res["tasks"][name + ":stop"] = c.ps("cleanup-stop", s_stop(name))
        res["tasks"][name] = c.call("cleanup-drop", m.drop_task, name, detail={"task": name})
    made = any(e["phase"] == "result" and e["step"] == "mkdir-outer" and (e["detail"] or {}).get("created") for e in J)
    res["outer"] = c.call("cleanup-remove", m.remove_dir, P["outer"]) if made else "not created by this run"
    v = c.ps("cleanup-verify", s_verify(P["prefix"], P["outer"], P["winUser"]))
    res["verify"] = v; res["clean"] = (not v.get("error") and v.get("tasks") == [] and v.get("outer") is False)
    return res


def verdict(ev, P):
    if ev.get("refused"): return {"G1": "NOT-RUN", "why": ev["refused"]}
    if ev.get("abort"): return {"G1": "FAIL", "why": ev["abort"]}
    R = P["roles"]; ck = {f"{k}.controllerArgsMatch": bool((ev["tasks"].get(k) or {}).get("register", {}).get("argsMatch")) for k in R}
    col = ev.get("collect") or {}; reg_at = {}
    for k in R:
        reg_at[k] = parse_utc(ev["tasks"][k]["definition"].get("now"))
    trig = {k: parse_utc(ev["tasks"][k]["definition"]["triggers"][0]["startUtc"]) for k in ("n", "o")}
    hits = {h["role"]: h for h in ((ev.get("watch") or {}).get("hits") or [])}
    events = (ev.get("events") or {}).get("events") or []
    def ran_after(k, t): lr = parse_utc((col.get(k) or {}).get("lastRun")); return lr is not None and t is not None and lr >= t - 1
    for k in ("o", "s"):
        rc = (col.get(k) or {}).get("receipt") or {}
        ck[f"{k}.receipt"] = rc.get("decision") == "facts" and rc.get("mode") == "preflight" and rc.get("runId") == P["run"] + k and rc.get("sandbox") is True and rc.get("factsAllAbsent") is True and rc.get("factsSshd") == "sandbox"
        ck[f"{k}.noRefusal"] = (col.get(k) or {}).get("refused") is None
        ck[f"{k}.lastResult0"] = (col.get(k) or {}).get("lastResult") == 0
        ck[f"{k}.stillRegisteredAfterRun"] = (col.get(k) or {}).get("registered") is True
    ck["o.firedByTrigger"] = ran_after("o", trig["o"]) and (parse_utc(((col.get("o") or {}).get("receipt") or {}).get("created")) or 0) >= trig["o"] - 1
    ck["s.ranAfterStart"] = ran_after("s", reg_at["s"]) and (ev.get("start") or {}).get("started") is True   # no trigger: only our start can run it
    cn = col.get("n") or {}
    ck["n.firedByTrigger"] = ran_after("n", trig["n"])
    ck["n.refusedByLauncher"] = ((cn.get("refused") or {}).get("text") == "hash params.json")
    ck["n.receiverNeverRan"] = cn.get("receipt") is None and "receipt-preflight.json" not in (cn.get("files") or []) and "state.json" not in (cn.get("files") or [])
    ck["n.exit9"] = cn.get("lastResult") == 9
    ck["n.tamperBeforeTrigger"] = bool((ev.get("tamper") or {}).get("valid"))
    after = {i["path"]: i for i in ((ev.get("stageAfter") or {}).get("items") or [])}
    ck["stage.stillTrustedAfter"] = bool(after) and all(i.get("exists") and not i.get("reparse") and i.get("owner") in TRUSTED[:2] and not i.get("write") for i in after.values())
    # identity: direct sources only (the stored principal alone is not counted as an observation)
    ident = {}
    for k in R:
        h = hits.get(k); e100 = [e for e in events if e.get("id") == 100 and str(e.get("task", "")).endswith(R[k]["task"])]
        ident[k] = {"process": bool(h and h.get("owner") == "NT AUTHORITY\\SYSTEM" and h.get("session") == 0 and (h.get("exe") or "").lower() == PS_EXE.lower() and h.get("parentSchedule")),
                    "event100": bool(e100 and all(str(e.get("user", "")).upper().endswith("SYSTEM") for e in e100))}
    ident_ok = all(v["process"] or v["event100"] for v in ident.values())
    hard = all(ck.values())
    g1 = "PASS" if hard and ident_ok else ("INCOMPLETE: Task Scheduler ran the SYSTEM-principal tasks, but no direct identity observation for every role" if hard else "FAIL")
    wf = parse_utc((ev.get("watch") or {}).get("from")); slr = parse_utc((col.get("s") or {}).get("lastRun"))
    note = "s started before the watcher was polling: raise leadSec" if (wf and slr and slr < wf) else None
    failed = [k for k, v in ck.items() if not v]
    if (ev["tasks"].get("s") or {}).get("controllerWouldNotStart"):
        failed.insert(0, "the controller's register_task(no trigger) returned argsMatch=false (triggerCount=%s): it would never start apply/rollback"
                      % (ev["tasks"]["s"]["definition"].get("triggerCount")))
    return {"G1": g1, "failed": failed, "checks": ck, "identity": ident, "watchFrom": (ev.get("watch") or {}).get("from"), "note": note,
            "evidenceKind": "TASK-SCHEDULER execution (not launcher text run in an SSH session)"}


def cmd_run(a):
    c, m = open_plan(a.run, a.plan_sha)
    pr = c.dir / "PARSE-RESULT.json"
    if not pr.exists() or not json.loads(pr.read_text()).get("ok") or json.loads(pr.read_text()).get("planSha") != a.plan_sha: sys.exit("run `parse` for this plan first (it must be clean)")
    if any(e["step"] == "preflight" for e in c.journal()): sys.exit("this run id already ran: plan a new one (cleanup: `cleanup --run`)")
    ev = {}
    try:
        run_canary(c, m, ev)
    finally:
        cl = cleanup(c, m) if any(e["step"] == "preflight" for e in c.journal()) else {"clean": True, "note": "nothing remote"}
        try: v = verdict(ev, c.plan) if (ev.get("refused") or ev.get("abort") or ev.get("collect")) else {"G1": "FAIL", "why": "interrupted before collection"}
        except Exception as e: v = {"G1": "FAIL", "why": f"evidence incomplete: {type(e).__name__}: {e}"}
        rb, ra = (ev.get("preflight") or {}).get("real"), (cl.get("verify") or {}).get("real")
        v.setdefault("checks", {})["real.unchanged"] = bool(rb) and rb == ra and rb.get("user") is False and rb.get("keys") is False
        if v["G1"] == "PASS" and not v["checks"]["real.unchanged"]: v["G1"] = "FAIL"; v.setdefault("failed", []).append("real.unchanged")
        out = {"at": utc(), "run": c.run, "verdict": v, "cleanup": cl, "evidence": ev}
        (c.dir / "G1-RESULT.json").write_text(json.dumps(out, indent=1) + "\n")
        print(json.dumps({"run": c.run, "G1": v["G1"], "checks": v.get("checks"), "identity": v.get("identity"), "why": v.get("why"),
                          "cleanupClean": cl.get("clean"), "result": str(c.dir / "G1-RESULT.json")}, indent=1))
    if not cl.get("clean"): sys.exit(3)
    if v["G1"] != "PASS": sys.exit(2)


def cmd_cleanup(a):
    if not re.fullmatch(r"g1[0-9a-f]{8}", a.run or ""): sys.exit("--run must be a run id printed by plan")
    c = Canary(a.run); m = c.load()
    cl = cleanup(c, m); (c.dir / f"CLEANUP-{utc().replace(':', '')}.json").write_text(json.dumps(cl, indent=1) + "\n"); print(json.dumps(cl, indent=1))
    if not cl.get("clean"): sys.exit(3)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("plan"); p.add_argument("--manifest", required=True); p.add_argument("--offset-min", type=int, default=2)
    for n in ("parse", "run"):
        p = sp.add_parser(n); p.add_argument("--run", required=True); p.add_argument("--plan-sha", required=True)
    p = sp.add_parser("cleanup"); p.add_argument("--run", required=True)
    sp.add_parser("self-test")
    a = ap.parse_args()
    if a.cmd == "self-test":
        import test_g1_canary; sys.exit(test_g1_canary.main())
    {"plan": cmd_plan, "parse": cmd_parse, "run": cmd_run, "cleanup": cmd_cleanup}[a.cmd](a)
