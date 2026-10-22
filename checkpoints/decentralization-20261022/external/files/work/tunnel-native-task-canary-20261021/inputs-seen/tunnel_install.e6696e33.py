#!/usr/bin/env python3
"""ROOT-ONLY controller v2: the control VM -> minipc challenge-DNS feed (minipc 127.0.0.1:31053 -> VM 127.0.0.1:1053).
Prepared by Claude e49af456; nothing here has been applied. Each remote step writes an attempt record BEFORE the call and a
receipt after it, is never auto-retried, and refuses on any pin mismatch.

Accounts: the VM keeps its EXISTING Linux user enclave-control-tunnel and identity. minipc gets a NEW dedicated Windows
account WINUSER (SAM names are at most 20 characters).

Read-only:            pin | vm-preflight | minipc-preflight
Isolated checks:      minipc-candidate-check   the actual sshd.exe: -t / -T -C on a candidate in a staging dir, then removed
                      minipc-sandbox-test      the receiver's logic AND the exact task launcher natively (sandbox mode:
                                               copies, fake accounts, no restart, no task), in one protected dir, removed
                      minipc-parse-check       PowerShell's parser over every script the change steps build (none run)
Changes (root):       minipc-stage RUN -> minipc-apply RUN -> vm-apply -> vm-enable -> verify RUN -> minipc-confirm RUN
Rollback:             vm-rollback | minipc-rollback RUN   (each reverts ONLY its own recorded mutations; conflicts are
                                                           reported, never called success)
"""
import base64, datetime, hashlib, importlib.util, json, os, pathlib, re, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
WORK = HERE.parents[4]                                     # .../wo/work
REC = HERE / "receipts"
GUARD_MIN = 10
WINUSER = "enc-ctl-tunnel"                                 # 14 <= 20 (New-LocalUser -Name: at most 20 characters)
DESC = "Enclave challenge-DNS tunnel -R 127.0.0.1:31053"     # Windows local-user descriptions: at most 48 characters
STAGE_ROOT = r"C:\ProgramData\Enclave\staging"
STAGE_WIN = STAGE_ROOT + r"\tunnel-{run}"
VM = ["ssh", "-p32423", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", f"UserKnownHostsFile={WORK}/control-vm/known_hosts",
      "-i", "/home/steven/.ssh/minipc", "controladmin@127.0.0.1"]
FILES = ["vm/enclave-control-tunnel-minipc.sh", "vm/enclave-control-tunnel-minipc.service", "vm/vm-state.py", "vm/verify-negative.py",
         "minipc/tunnel-receiver.ps1", "minipc/sandbox-test.ps1"]
assert len(WINUSER) <= 20 and re.fullmatch(r"[a-z0-9][a-z0-9-]*", WINUSER) and len(DESC) <= 48


def now(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def sha(b): return hashlib.sha256(b if isinstance(b, bytes) else b.encode()).hexdigest()
def rec(name, obj):
    REC.mkdir(exist_ok=True); p = REC / f"{name}-{now().replace(':', '')}.json"; p.write_text(json.dumps(obj, indent=1) + "\n"); return p
def attempt(name, what): return rec(f"attempt-{name}", {"what": what, "at": now()})
def latest(prefix):
    c = sorted(REC.glob(prefix + "-*.json")); return json.loads(c[-1].read_text()) if c else None
def local_files(): return {k: sha((HERE / k).read_bytes()) for k in FILES}


def managed_block(user=WINUSER):
    """the exact bytes tunnel-receiver.ps1 renders ($BLOCK); the receiver refuses unless its rendering hashes to this"""
    return "\r\n".join([f"# BEGIN {user} (managed by tunnel-receiver.ps1; do not edit)", f"Match User {user}",
        f"    AuthorizedKeysFile __PROGRAMDATA__/ssh/{user}_authorized_keys", "    AuthenticationMethods publickey",
        "    PasswordAuthentication no", "    PubkeyAuthentication yes", "    AllowTcpForwarding remote", "    PermitListen 127.0.0.1:31053",
        "    PermitOpen none", "    GatewayPorts no", "    PermitTTY no", "    X11Forwarding no", "    AllowAgentForwarding no",
        "    AllowStreamLocalForwarding no", "    PermitTunnel no", "    ForceCommand cmd.exe /c exit 1", f"# END {user}"])


def keys_line(pub): return f'restrict,port-forwarding,permitlisten="127.0.0.1:31053",command="cmd.exe /c exit 1" {pub}\r\n'


_m = None
def ps(script, secs=90):
    """root's reviewed transport (watchdog, EncodedCommand, JSON) -> dict"""
    global _m
    if _m is None:
        s = importlib.util.spec_from_file_location("t", WORK / "nucbox-tls-20261021/root-activate-reviewed.py")
        _m = importlib.util.module_from_spec(s); s.loader.exec_module(_m)
    r = _m.ps(script + ";$j=$o|ConvertTo-Json -Depth 6 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress", secs=secs)
    if r.get("payload"): r = json.loads(base64.b64decode(r["payload"]).decode())
    return r


def vm(script, timeout=90):
    r = subprocess.run(VM + ["bash -s"], input=script, capture_output=True, text=True, timeout=timeout)
    return {"rc": r.returncode, "out": r.stdout, "err": r.stderr[-1500:]}


def pins():
    p = latest("pins")
    if not p: sys.exit("no receipts/pins-*.json: run `pin` first")
    if p.get("files") != local_files(): sys.exit("local files changed since `pin`: review again and re-pin")
    return p


# ---- the trust check, identical in the stage proof, the task launcher and (as TrustProblem) the receiver ----
TRUST = ("function T($p){$i=Get-Item -LiteralPath $p -Force;if($i.Attributes -band 1024){return \"reparse $p\"};$a=Get-Acl -LiteralPath $p;"
         "$S=[Security.Principal.SecurityIdentifier];$ok='S-1-5-18','S-1-5-32-544';$w=$a.GetOwner($S).Value;if($w -notin $ok){return \"owner $w $p\"};"
         "foreach($e in $a.GetAccessRules($true,$true,$S)){$w=$e.IdentityReference.Value;"
         "if($e.AccessControlType -eq 'Allow' -and ([int]$e.FileSystemRights -band 0x500D0156) -and $w -notin $ok){return \"write $w $p\"}}};")


def launcher(d, mode, hashes):
    """the scheduled task's whole program: trust check of the dir + every file, the exact sha256 of params.json, and of
    the receiver BYTES it then runs (read once: hashed bytes == executed bytes, no execution-policy change). Any problem,
    including an error while checking -> launcher-refused-<mode>.txt, exit 9, the receiver never runs. -> -EncodedCommand"""
    s = ("$ErrorActionPreference='Stop';$d='" + d + "';" + TRUST + "$bad=@();try{"
         "$bad=@(@($d)+@(Get-ChildItem -LiteralPath $d -Force|%{$_.FullName})|%{T $_}|?{$_});"
         "$sh=[Security.Cryptography.SHA256]::Create();$rb=[IO.File]::ReadAllBytes(\"$d\\tunnel-receiver.ps1\");"
         "if((-join($sh.ComputeHash($rb)|%{$_.ToString('x2')})) -ne '" + hashes["tunnel-receiver.ps1"] + "'){$bad+='hash tunnel-receiver.ps1'};"
         "if((-join($sh.ComputeHash([IO.File]::ReadAllBytes(\"$d\\params.json\"))|%{$_.ToString('x2')})) -ne '" + hashes["params.json"] + "'){$bad+='hash params.json'}"
         "}catch{$bad+=\"error $_\"};"
         "if($bad.Count){Set-Content -LiteralPath \"$d\\launcher-refused-" + mode + ".txt\" -Value ($bad -join '; ');exit 9};"
         "& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($rb).TrimStart([char]0xFEFF))) -Mode " + mode + " -Dir $d")
    assert set(hashes) == {"tunnel-receiver.ps1", "params.json"}
    return base64.b64encode(s.encode("utf-16-le")).decode()


def task_args(d, mode, hashes): return "-NoProfile -NonInteractive -EncodedCommand " + launcher(d, mode, hashes)


def launcher_text(d, mode, hashes): return base64.b64decode(launcher(d, mode, hashes)).decode("utf-16-le")


def register_task(name, mode, d, at_expr, hashes):
    """one task per call (transport limit); the launcher TEXT travels and is encoded there; -> the registered Arguments
    must equal task_args() exactly, i.e. SYSTEM will run exactly the pinned launcher. at_expr None = NO trigger: the task
    runs only when start_task() starts it after this verification (a lost controller leaves it never run)."""
    lt = launcher_text(d, mode, hashes).replace("'", "''")
    trig = (";$tr=New-ScheduledTaskTrigger -Once -At (" + at_expr + ")") if at_expr else ""
    r = ps("$L='" + lt + "';$arg='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($L));"
           "$a=New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Argument $arg" + trig + ";"
           "$pr=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;"
           "$st=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable;"
           "Register-ScheduledTask -TaskName '" + name + "' -Action $a" + (" -Trigger $tr" if at_expr else "") + " -Principal $pr -Settings $st|Out-Null;"
           "$k=Get-ScheduledTask -TaskName '" + name + "';$o=[ordered]@{state=[string]$k.State;user=[string]$k.Principal.UserId;triggers=@($k.Triggers).Count;"
           "argSha=-join([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$k.Actions[0].Arguments))|%{$_.ToString('x2')})}")
    r["argsMatch"] = (r.get("argSha") == sha(task_args(d, mode, hashes)) and r.get("state") == "Ready" and r.get("user") == "SYSTEM"
                      and r.get("triggers") == (1 if at_expr else 0))
    return r


def start_task(name): return ps(rf"Start-ScheduledTask -TaskName '{name}';$o=[ordered]@{{started=$true;state=[string](Get-ScheduledTask -TaskName '{name}').State}}", secs=40)
def drop_task(name): return ps(rf"Unregister-ScheduledTask -TaskName '{name}' -Confirm:$false -ErrorAction SilentlyContinue;$o=[ordered]@{{gone=-not (Get-ScheduledTask -TaskName '{name}' -ErrorAction SilentlyContinue)}}", secs=40)


def mkdir_protected(d):
    """a NEW dir under the existing staging root with its OWN protected ACL (SYSTEM + Administrators); the parent is
    never modified; refuses an existing dir or a reparse-point parent"""
    return ps(rf"""$d='{d}';$pa=Split-Path $d;$o=[ordered]@{{dir=$d}};
if(-not (Test-Path -LiteralPath $pa)){{$o.error='staging root absent'}}elseif((Get-Item -LiteralPath $pa -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){{$o.error='staging root is a reparse point'}}
elseif(Test-Path -LiteralPath $d){{$o.error='exists'}}else{{$ds=New-Object Security.AccessControl.DirectorySecurity;$ds.SetAccessRuleProtection($true,$false);
foreach($w in 'S-1-5-18','S-1-5-32-544'){{$ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $w),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}};
[void][IO.Directory]::CreateDirectory($d,$ds);$o.parentSddlUnchanged=$true;$o.created=$true}}""")


def scp_to(d, files):
    for f in files:
        subprocess.run(["scp", "-q", str(f), f"minipc:{d.replace(chr(92), '/')}/{pathlib.Path(f).name}"], check=True, timeout=60)


def seal_and_prove(d, names):
    """Administrators own the staged files, which inherit the dir's protected ACL; -> trust result + hashes + SDDL proof"""
    return ps(rf"""$d='{d}';{TRUST}foreach($n in @({",".join(f"'{n}'" for n in names)})){{$p2=Join-Path $d $n;& icacls.exe $p2 /setowner '*S-1-5-32-544' /Q|Out-Null;& icacls.exe $p2 /reset /Q|Out-Null}};
$o=[ordered]@{{dirSddl=(Get-Acl -LiteralPath $d).Sddl;trust=@(@($d)+@(Get-ChildItem -LiteralPath $d -Force|ForEach-Object{{$_.FullName}})|ForEach-Object{{T $_}}|Where-Object{{$_}});
files=[ordered]@{{}}}};foreach($f in Get-ChildItem -LiteralPath $d -File -Force){{$o.files[$f.Name]=[ordered]@{{sha=(Get-FileHash -Algorithm SHA256 -LiteralPath $f.FullName).Hash.ToLower();sddl=(Get-Acl -LiteralPath $f.FullName).Sddl}}}}""")


def fresh_proof(d):
    return ps(rf"$d='{d}';{TRUST}$o=[ordered]@{{trust=@(@($d)+@(Get-ChildItem -LiteralPath $d -Force|ForEach-Object{{$_.FullName}})|ForEach-Object{{T $_}}|Where-Object{{$_}});files=[ordered]@{{}}}};foreach($f in Get-ChildItem -LiteralPath $d -File -Force){{$o.files[$f.Name]=(Get-FileHash -Algorithm SHA256 -LiteralPath $f.FullName).Hash.ToLower()}}")


def write_confirm(d):
    """confirm.ok owned by Administrators with the dir's inherited ACL (the guard's launcher refuses any other owner)"""
    return ps(rf"$c=Join-Path '{d}' 'confirm.ok';Set-Content -LiteralPath $c -Value ([DateTime]::UtcNow.ToString('o'));& icacls.exe $c /setowner '*S-1-5-32-544' /Q|Out-Null;& icacls.exe $c /reset /Q|Out-Null;{TRUST}$o=[ordered]@{{confirm=(Test-Path $c);trust=(T $c)}}")


def remove_dir(d):
    return ps(rf"$d='{d}';$o=[ordered]@{{dir=$d}};if(Test-Path -LiteralPath $d){{Remove-Item -LiteralPath $d -Recurse -Force}};$o.removed=-not (Test-Path -LiteralPath $d)")


# ----------------------------------------------------------------------------------------------------------- read-only
def cmd_pin():
    attempt("pin", "read the VM tunnel PUBLIC key and minipc's host key")
    v = vm("""set -u; d=/var/lib/enclave-control-tunnel
if sudo test -f $d/id_ed25519.pub; then sudo cat $d/id_ed25519.pub; else sudo ssh-keygen -y -f $d/id_ed25519; fi""")
    pub = v["out"].strip().split()
    if v["rc"] != 0 or len(pub) < 2 or pub[0] != "ssh-ed25519": sys.exit(f"VM public key unreadable: {v}")
    public_key = f"{pub[0]} {pub[1]}"
    m = ps(r"$o=[ordered]@{key=(Get-Content -LiteralPath 'C:\ProgramData\ssh\ssh_host_ed25519_key.pub' -Raw).Trim()}")
    hk = str(m.get("key", "")).split()
    if len(hk) < 2 or hk[0] != "ssh-ed25519": sys.exit(f"minipc host key unreadable: {m}")
    g = dict(l.split(" ", 1) for l in subprocess.run(["ssh", "-G", "minipc"], capture_output=True, text=True).stdout.splitlines() if " " in l)
    name = g.get("hostkeyalias") if g.get("hostkeyalias", "none") != "none" else g.get("hostname")
    known = "".join(subprocess.run(["ssh-keygen", "-F", name, "-f", os.path.expanduser(f)], capture_output=True, text=True).stdout
                    for f in g.get("userknownhostsfile", "~/.ssh/known_hosts").split() if os.path.exists(os.path.expanduser(f)))
    blobs = {l.split()[2] for l in known.splitlines() if l and not l.startswith("#") and len(l.split()) >= 3 and l.split()[1] == "ssh-ed25519"}
    if hk[1] not in blobs: sys.exit("minipc's host key does not match the workstation's pinned known_hosts entry: refusing (no blind trust)")
    fp = lambda k: subprocess.run(["ssh-keygen", "-lf", "-"], input=k + "\n", capture_output=True, text=True).stdout.split()[1]
    out = {"at": now(), "winUser": WINUSER, "publicKey": public_key, "publicKeyFingerprint": fp(public_key),
           "minipcHostKey": f"{hk[0]} {hk[1]}", "minipcHostKeyFingerprint": fp(f"{hk[0]} {hk[1]}"),
           "knownHostsLine": f"minipc-hyperv {hk[0]} {hk[1]}", "keysSha": sha(keys_line(public_key)), "blockSha": sha(managed_block()),
           "files": local_files()}
    print(json.dumps({k: out[k] for k in ("winUser", "publicKeyFingerprint", "minipcHostKeyFingerprint", "keysSha", "blockSha")}, indent=1))
    print("receipt", rec("pins", out))


def cmd_vm_preflight():
    attempt("vm-preflight", "read-only")
    v = vm("""set -u; d=/var/lib/enclave-control-tunnel
echo "unit=$(test -e /etc/systemd/system/enclave-control-tunnel-minipc.service && sha256sum /etc/systemd/system/enclave-control-tunnel-minipc.service | cut -c1-64 || echo absent)"
echo "script=$(test -e /usr/local/libexec/enclave-control-tunnel-minipc.sh && sha256sum /usr/local/libexec/enclave-control-tunnel-minipc.sh | cut -c1-64 || echo absent)"
echo "stateReceipt=$(sudo test -e /var/lib/enclave-control-tunnel-minipc.state/receipt.json && echo present || echo absent)"
echo "knownHosts=$(sudo sha256sum $d/known_hosts | cut -c1-64)"
echo "aliasLines=$(sudo grep -c '^minipc-hyperv ' $d/known_hosts || true)"
echo "identity=$(sudo test -f $d/id_ed25519 && echo present || echo absent)"
echo "user=$(id -u enclave-control-tunnel >/dev/null 2>&1 && echo present || echo absent)"
echo "gateway=$(ip -4 route show default | awk '/^default/{print $3; exit}')"
echo "dns1053=$(ss -Hlnt 'sport = :1053' | awk '{print $4}' | tr '\\n' ' ')"
for u in us-west eu-central ap-southeast ca-east; do echo "tunnel-$u=$(systemctl is-active enclave-control-tunnel-$u)"; done
""")
    facts = dict(l.split("=", 1) for l in v["out"].splitlines() if "=" in l)
    out = {"at": now(), "rc": v["rc"], "facts": facts}
    print(json.dumps(out, indent=1)); print("receipt", rec("vm-preflight", out))


CAND = r"""$CFG='C:\ProgramData\ssh\sshd_config';$t=[IO.File]::ReadAllText($CFG);$blk=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('BLOCKB64'));
$new=$t.TrimEnd("`r","`n")+"`r`n`r`n"+$blk+"`r`n";$h=[Security.Cryptography.SHA256]::Create();
$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');configSha=(Get-FileHash -Algorithm SHA256 -LiteralPath $CFG).Hash.ToLower();candidateSha=(($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($new))|ForEach-Object{$_.ToString('x2')}) -join '')}"""


def cmd_minipc_preflight():
    attempt("minipc-preflight", "read-only")
    blk = base64.b64encode(managed_block().encode()).decode()
    r = ps(CAND.replace("BLOCKB64", blk) + rf""";$u=Get-LocalUser -Name '{WINUSER}' -ErrorAction SilentlyContinue;$o.userPresent=[bool]$u;
$o.blockPresent=$t.Contains('# BEGIN {WINUSER}');$o.keysFile=(Test-Path 'C:\ProgramData\ssh\{WINUSER}_authorized_keys');
$o.sshd=[string](Get-Service sshd).Status;$o.version=(Get-Item 'C:\Windows\System32\OpenSSH\sshd.exe').VersionInfo.ProductVersion;
$o.listen31053=@(Get-NetTCPConnection -LocalPort 31053 -State Listen -ErrorAction SilentlyContinue).Count;
$o.backupParent=$(if(Test-Path 'C:\ProgramData\Enclave\backup'){{(Get-Acl 'C:\ProgramData\Enclave\backup').Sddl}}else{{'absent'}})""")
    print(json.dumps(r, indent=1)); print("receipt", rec("minipc-preflight", r))


def cmd_minipc_candidate_check():
    """isolated: candidate in its own protected staging dir; the actual sshd.exe tests it; the dir is removed"""
    run = "cand" + now().replace(":", "").replace("-", "").lower()
    d = STAGE_WIN.format(run=run); attempt("minipc-candidate-check", d)
    mk = mkdir_protected(d)
    if not mk.get("created"): sys.exit(f"staging refused: {mk}")
    (REC / "tmp").mkdir(parents=True, exist_ok=True)
    blkf = REC / "tmp" / "block.txt"; blkf.write_bytes(managed_block().encode())
    try:
        scp_to(d, [HERE / "minipc/tunnel-receiver.ps1", blkf])
        cand = CAND.replace("[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('BLOCKB64'))", "[IO.File]::ReadAllText('STAGEDIR\\block.txt')")
        script = (cand + r""";$d='STAGEDIR';$S='C:\Windows\System32\OpenSSH\sshd.exe';$c=Join-Path $d 'sshd_config.candidate';[IO.File]::WriteAllText($c,$new,(New-Object Text.UTF8Encoding $false));
$ErrorActionPreference='Continue';$x=& $S -t -f $c 2>&1;$o.syntaxRc=$LASTEXITCODE;$o.syntaxOut=(($x|Out-String).Trim());
$y=& $S -T -f $c -C 'user=WINUSER,host=minipc-hyperv,addr=172.19.137.173,laddr=172.19.128.1,lport=22' 2>&1;$o.effectiveRc=$LASTEXITCODE;
$want='^(authorizedkeysfile|authenticationmethods|passwordauthentication|pubkeyauthentication|allowtcpforwarding|permitlisten|permitopen|gatewayports|permittty|x11forwarding|allowagentforwarding|allowstreamlocalforwarding|permittunnel|forcecommand) ';
$o.effective=@($y|ForEach-Object{[string]$_}|Where-Object{$_ -match $want});
$CS='user=claude,host=workstation,addr=192.168.8.249,laddr=192.168.8.238,lport=22';$l1=@(& $S -T -f $CFG -C $CS 2>&1|ForEach-Object{[string]$_});$l2=@(& $S -T -f $c -C $CS 2>&1|ForEach-Object{[string]$_});
$o.adminSame=(($l1 -join "`n") -eq ($l2 -join "`n"));$o.adminLines=$l1.Count;$o.adminDiff=@(Compare-Object $l1 $l2).Count;
$e=$null;$tk=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'tunnel-receiver.ps1'),[ref]$tk,[ref]$e);$o.ps1Sha=(Get-FileHash -Algorithm SHA256 (Join-Path $d 'tunnel-receiver.ps1')).Hash.ToLower();$o.ps1ParseErrors=@($e|ForEach-Object{$_.Message+' @'+$_.Extent.StartLineNumber});
$o.productionConfigSha=(Get-FileHash -Algorithm SHA256 -LiteralPath $CFG).Hash.ToLower()""").replace("STAGEDIR", d).replace("WINUSER", WINUSER)
        r = ps(script, secs=90)
    finally:
        rm = remove_dir(d)
    r["stagingRemoved"] = rm.get("removed"); r["localPs1Sha"] = sha((HERE / "minipc/tunnel-receiver.ps1").read_bytes())
    print(json.dumps(r, indent=1)); print("receipt", rec("minipc-candidate-check", r))


def cmd_minipc_sandbox_test():
    """the receiver's logic AND the exact task launcher, natively, in sandbox mode only (copies, fake accounts, no restart,
    no task); the whole protected dir is removed afterwards. Needs a fresh minipc-preflight (G's pinned config hashes)."""
    p = pins(); pre = latest("minipc-preflight")
    if not pre or not pre.get("candidateSha"): sys.exit("run minipc-preflight first")
    run = "sbx" + now().replace(":", "").replace("-", "").lower()
    d = STAGE_WIN.format(run=run); attempt("minipc-sandbox-test", d)
    tmp = REC / "tmp" / run; tmp.mkdir(parents=True, exist_ok=True)
    (tmp / "block.txt").write_bytes(managed_block().encode())
    (tmp / "test.json").write_text(json.dumps({"publicKey": p["publicKey"], "winUser": WINUSER}))
    # scenario G: what minipc-stage would stage (sandbox=true), and the launchers for its dir with ITS hashes
    g = {"runId": "G", "winUser": WINUSER, "sandbox": True, "sandboxRoot": d + "\\G", "publicKey": p["publicKey"], "keysSha": p["keysSha"],
         "blockSha": p["blockSha"], "expectConfigSha": pre["configSha"], "appliedConfigSha": pre["candidateSha"], "userDescription": DESC}
    (tmp / "G-params.json").write_text(json.dumps(g, indent=1))
    gh = {"tunnel-receiver.ps1": sha((HERE / "minipc/tunnel-receiver.ps1").read_bytes()), "params.json": sha((tmp / "G-params.json").read_bytes())}
    for mode in ("apply", "rollback"):
        (tmp / f"G-launch-{mode}.txt").write_bytes(launcher_text(d + "\\G\\stage", mode, gh).encode())
    mk = mkdir_protected(d)
    if not mk.get("created"): sys.exit(f"staging refused: {mk}")
    try:
        scp_to(d, [HERE / "minipc/tunnel-receiver.ps1", HERE / "minipc/sandbox-test.ps1", tmp / "block.txt", tmp / "test.json",
                   tmp / "G-params.json", tmp / "G-launch-apply.txt", tmp / "G-launch-rollback.txt"])
        r = ps(rf"$o=(& ([scriptblock]::Create([IO.File]::ReadAllText('{d}\sandbox-test.ps1'))) -HERE '{d}' | Select-Object -Last 1) | ConvertFrom-Json", secs=300)
    finally:
        rm = remove_dir(d)
    r = r if isinstance(r, dict) else {"raw": r}
    r["stagingRemoved"] = rm.get("removed"); r["receiverSha"] = p["files"]["minipc/tunnel-receiver.ps1"]; r["gHashes"] = gh
    print(json.dumps(r, indent=1)[:8000]); print("receipt", rec("minipc-sandbox-test", r))
    if r.get("failed") != 0: sys.exit("sandbox test FAILED")


def built_scripts(run="parsecheck0"):
    """every remote script the change steps would send, built by the real code paths with a recording ps() (nothing sent)"""
    global ps
    real, got = ps, []
    ps = lambda script, secs=90: (got.append(script), {})[1]
    try:
        h = {"tunnel-receiver.ps1": "0" * 64, "params.json": "1" * 64}; d = STAGE_WIN.format(run=run)
        mkdir_protected(d); seal_and_prove(d, ["params.json", "tunnel-receiver.ps1"]); remove_dir(d); minipc_listener()
        register_task(f"EnclaveTunnelGuard-{run}", "guard", d, f"(Get-Date).AddMinutes({GUARD_MIN})", h)
        register_task(f"EnclaveTunnelApply-{run}", "apply", d, None, h); start_task(f"EnclaveTunnelApply-{run}"); drop_task(f"EnclaveTunnelApply-{run}")
        fresh_proof(d); write_confirm(d)
        sl, time.sleep = time.sleep, (lambda x: None)
        try: poll_decision(d, "apply", tries=1)
        finally: time.sleep = sl
        got.append(launcher_text(d, "guard", h))
    finally:
        ps = real
    return got


def cmd_minipc_parse_check():
    """isolated: Windows PowerShell's own parser over every script the change steps build (none is RUN), plus the
    Register-ScheduledTask parameter metadata (a trigger-less registration is valid); staging removed"""
    run = "parse" + now().replace(":", "").replace("-", "").lower()
    d = STAGE_WIN.format(run=run); attempt("minipc-parse-check", d)
    tmp = REC / "tmp" / run; tmp.mkdir(parents=True, exist_ok=True)
    scripts = built_scripts(); (tmp / "scripts.json").write_text(json.dumps(scripts))
    mk = mkdir_protected(d)
    if not mk.get("created"): sys.exit(f"staging refused: {mk}")
    try:
        scp_to(d, [tmp / "scripts.json"])
        r = ps(rf"""$x=Get-Content -Raw -LiteralPath '{d}\scripts.json'|ConvertFrom-Json;$o=[ordered]@{{count=0;errors=@()}};
foreach($t in @($x)){{$o.count++;$e=$null;$tk=$null;[void][Management.Automation.Language.Parser]::ParseInput([string]$t,[ref]$tk,[ref]$e);foreach($y in @($e)){{if($y){{$o.errors+=('#'+$o.count+': '+$y.Message)}}}}}};
$c=Get-Command Register-ScheduledTask;$o.triggerMandatory=@($c.Parameters['Trigger'].Attributes|Where-Object{{$_ -is [Management.Automation.ParameterAttribute] -and $_.Mandatory}}).Count;
$o.forceIsSwitch=[bool]$c.Parameters['Force'];$o.startTask=[bool](Get-Command Start-ScheduledTask)""", secs=60)
    finally:
        rm = remove_dir(d)
    r["stagingRemoved"] = rm.get("removed"); r["sent"] = len(scripts)
    print(json.dumps(r, indent=1)); print("receipt", rec("minipc-parse-check", r))
    if r.get("errors") or r.get("count") != len(scripts) or r.get("triggerMandatory") != 0: sys.exit("parse check FAILED")


# ------------------------------------------------------------------------------------------------------------- changes
def cmd_minipc_stage(run):
    p = pins(); pre = latest("minipc-preflight")
    if not pre or pre.get("blockPresent") or pre.get("userPresent") or pre.get("keysFile"): sys.exit("fresh minipc-preflight needed (nothing installed)")
    params = {"runId": run, "winUser": WINUSER, "sandbox": False, "publicKey": p["publicKey"], "keysSha": p["keysSha"],
              "blockSha": p["blockSha"], "expectConfigSha": pre["configSha"], "appliedConfigSha": pre["candidateSha"], "userDescription": DESC}
    d = STAGE_WIN.format(run=run); attempt(f"minipc-stage-{run}", {"dir": d, "params": params})
    mk = mkdir_protected(d)
    if not mk.get("created"): sys.exit(f"staging refused: {mk}")
    tmpd = REC / "tmp" / run; tmpd.mkdir(parents=True, exist_ok=True)
    (tmpd / "params.json").write_text(json.dumps(params, indent=1)); (tmpd / "tunnel-receiver.ps1").write_bytes((HERE / "minipc/tunnel-receiver.ps1").read_bytes())
    scp_to(d, [tmpd / "params.json", tmpd / "tunnel-receiver.ps1"])
    proof = seal_and_prove(d, ["params.json", "tunnel-receiver.ps1"])
    hashes = {"tunnel-receiver.ps1": sha((tmpd / "tunnel-receiver.ps1").read_bytes()), "params.json": sha((tmpd / "params.json").read_bytes())}
    ok = not proof.get("trust") and all(proof.get("files", {}).get(k, {}).get("sha") == v for k, v in hashes.items()) and set(proof.get("files", {})) == set(hashes)
    out = {"at": now(), "run": run, "dir": d, "proof": proof, "hashes": hashes, "ok": ok, "params": params}
    print(json.dumps(out, indent=1)); print("receipt", rec(f"minipc-stage-{run}", out))
    if not ok: sys.exit("staged dir/bytes not proven: do not apply (remove it with care)")


def poll_decision(d, mode, tries=18):
    res = None
    for _ in range(tries):
        time.sleep(10)
        res = ps(rf"$p2=Join-Path '{d}' 'receipt-{mode}.json';$l=Join-Path '{d}' 'launcher-refused-{mode}.txt';$o=[ordered]@{{receipt=$(if(Test-Path $p2){{Get-Content -Raw $p2|ConvertFrom-Json}}else{{$null}});launcher=$(if(Test-Path $l){{Get-Content -Raw $l}}else{{$null}})}}", secs=40)
        if (res.get("receipt") or {}).get("decision") or res.get("launcher"): break
    return res


def cmd_minipc_apply(run):
    st = latest(f"minipc-stage-{run}")
    if not st or not st.get("ok"): sys.exit("stage this run first")
    d = st["dir"]; attempt(f"minipc-apply-{run}", {"guardMinutes": GUARD_MIN})
    # a FRESH proof right before SYSTEM is told to run anything: dir + files trusted and still the staged bytes
    proof = fresh_proof(d)
    if proof.get("trust") or proof.get("files") != st["hashes"]: sys.exit(f"the staged dir changed since stage: {proof}")
    # the guard FIRST, on its own timer (it must fire even if this controller is gone; apply refuses without it); then apply
    # with NO trigger, started only after its exact arguments are verified
    g = register_task(f"EnclaveTunnelGuard-{run}", "guard", d, f"(Get-Date).AddMinutes({GUARD_MIN})", st["hashes"])
    print("guard:", g)
    if not g.get("argsMatch"): sys.exit("the guard task is not exactly the pinned launcher: nothing applied; root inspects/unregisters it")
    r = register_task(f"EnclaveTunnelApply-{run}", "apply", d, None, st["hashes"])
    print("apply:", r)
    if not r.get("argsMatch"): sys.exit("the apply task is not exactly the pinned launcher: NOT started (it has no trigger); root unregisters it")
    print("start:", start_task(f"EnclaveTunnelApply-{run}"))
    res = poll_decision(d, "apply")
    if ((res or {}).get("receipt") or {}).get("decision") or (res or {}).get("launcher"): drop_task(f"EnclaveTunnelApply-{run}")
    out = {"at": now(), "run": run, "result": res}
    print(json.dumps(out, indent=1)[:4000]); print("receipt", rec(f"minipc-apply-{run}", out))
    dec = ((res or {}).get("receipt") or {}).get("decision")
    if (res or {}).get("launcher"): sys.exit(f"the launcher REFUSED (nothing ran): {res['launcher']}")
    if not dec: sys.exit(f"UNKNOWN outcome: do NOT retry. The guard runs at +{GUARD_MIN} min and reverts only what state.json records; then minipc-preflight.")
    if not dec.startswith("applied"): sys.exit(f"apply did not complete: {dec}")


def cmd_vm_apply():
    p = pins(); pre = latest("vm-preflight"); f = (pre or {}).get("facts", {})
    if f.get("unit") != "absent" or f.get("script") != "absent" or f.get("aliasLines") != "0" or f.get("identity") != "present" or f.get("stateReceipt") != "absent":
        sys.exit("fresh vm-preflight must show unit/script/state absent, no alias line, identity present")
    b = lambda k: base64.b64encode((HERE / k).read_bytes()).decode()
    attempt("vm-apply", {"knownHostsBefore": f.get("knownHosts")})
    v = vm(f"""set -eu; t=$(sudo mktemp -d)
echo {b('vm/enclave-control-tunnel-minipc.sh')} | base64 -d | sudo tee $t/script >/dev/null
echo {b('vm/enclave-control-tunnel-minipc.service')} | base64 -d | sudo tee $t/unit >/dev/null
echo {b('vm/vm-state.py')} | base64 -d | sudo python3 - apply $t/script $t/unit '{p['knownHostsLine']}' '{f['knownHosts']}'; rc=$?
sudo rm -rf $t; exit $rc""")
    out = {"at": now(), **v}
    print(json.dumps(out, indent=1)); print("receipt", rec("vm-apply", out))
    if v["rc"] != 0 or '"applied' not in v["out"]: sys.exit("vm-apply did not apply: read the receipt; vm-rollback reverts only what it recorded")


def minipc_listener():
    return ps(r"$o=[ordered]@{listen=@(Get-NetTCPConnection -LocalPort 31053 -State Listen -ErrorAction SilentlyContinue|ForEach-Object{$_.LocalAddress+' '+(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName})}", secs=40).get("listen") or []


def cmd_vm_enable():
    attempt("vm-enable", "enable --now")
    v = vm("sudo systemctl enable --now enclave-control-tunnel-minipc.service; sleep 3; systemctl is-active enclave-control-tunnel-minipc; journalctl -u enclave-control-tunnel-minipc -n 5 --no-pager -o cat")
    seen = []
    for _ in range(9):
        seen = minipc_listener()
        if seen: break
        time.sleep(5)
    out = {"at": now(), "vm": v, "minipcListener": seen}
    print(json.dumps(out, indent=1)); print("receipt", rec("vm-enable", out))


def cmd_verify(run):
    attempt(f"verify-{run}", "positive + authenticated negatives + reconnect")
    pos = ps(r"""$c=New-Object Net.Sockets.TcpClient;$c.ReceiveTimeout=3000;$c.Connect('127.0.0.1',31053);$s=$c.GetStream();
$q=[byte[]](0x51,0x51,1,0,0,1,0,0,0,0,0,0,3,97,112,112,7,101,110,99,108,97,118,101,4,104,111,115,116,0,0,6,0,1);
$s.Write([byte[]](0,$q.Length),0,2);$s.Write($q,0,$q.Length);$b=New-Object byte[] 4096;$n=0;$t=(Get-Date).AddSeconds(4);
while((Get-Date) -lt $t){if($s.DataAvailable){$n+=$s.Read($b,$n,4096-$n)};if($n -ge 2 -and $n -ge 2+$b[0]*256+$b[1]){break};Start-Sleep -Milliseconds 50};$c.Close();
$o=[ordered]@{listen=@(Get-NetTCPConnection -LocalPort 31053 -State Listen -ErrorAction SilentlyContinue|ForEach-Object{$_.LocalAddress+' '+(Get-Process -Id $_.OwningProcess).ProcessName});
soa=$(if($n -ge 14){[ordered]@{id=$b[2]*256+$b[3];rcode=($b[5] -band 15);aa=[bool]($b[4] -band 4);answers=$b[8]*256+$b[9]}}else{$null})}""", secs=60)
    vneg = base64.b64encode((HERE / "vm/verify-negative.py").read_bytes()).decode()
    neg = vm(f"echo {vneg} | base64 -d | sudo python3 -", timeout=240)
    negr = dict(l.split("=", 1) for l in neg["out"].splitlines() if "=" in l)
    vm("sudo systemctl kill --signal=TERM enclave-control-tunnel-minipc.service")
    gone = back = None
    for i in range(12):
        time.sleep(5); l = minipc_listener()
        if not l and gone is None: gone = i * 5 + 5
        if l and gone is not None: back = i * 5 + 5; break
    out = {"at": now(), "positive": pos, "negative": negr, "reconnect": {"goneAfterSec": gone, "backAfterSec": back}}
    ok = (any(x == "127.0.0.1 sshd" for x in (pos.get("listen") or [])) and (pos.get("soa") or {}).get("rcode") == 0 and (pos.get("soa") or {}).get("aa")
          and negr.get("overall") == "PASS" and back is not None)
    out["PASS"] = bool(ok)
    print(json.dumps(out, indent=1)); print("receipt", rec(f"verify-{run}", out))
    if not ok: sys.exit("verify FAILED: do not confirm; the guard reverts minipc; run vm-rollback")


def cmd_minipc_confirm(run):
    v = latest(f"verify-{run}")
    if not v or not v.get("PASS"): sys.exit("refused: verify did not PASS for this run")
    d = STAGE_WIN.format(run=run); attempt(f"minipc-confirm-{run}", d)
    r = write_confirm(d)
    if r.get("confirm") and not r.get("trust"): r["guardDropped"] = drop_task(f"EnclaveTunnelGuard-{run}")   # (if this fails, the guard fires and does nothing)
    print(r); rec(f"minipc-confirm-{run}", r)


def cmd_vm_rollback():
    attempt("vm-rollback", "revert only what vm-state recorded")
    vs = base64.b64encode((HERE / "vm/vm-state.py").read_bytes()).decode()
    v = vm(f"""echo {vs} | base64 -d | sudo python3 - rollback; rc=$?
for u in us-west eu-central ap-southeast ca-east; do echo "tunnel-$u=$(systemctl is-active enclave-control-tunnel-$u)"; done; exit $rc""")
    print(json.dumps(v, indent=1)); rec("vm-rollback", v)
    if v["rc"] != 0: sys.exit("vm-rollback did not complete cleanly: read the conflicts; nothing else was touched")


def cmd_minipc_rollback(run):
    st = latest(f"minipc-stage-{run}")
    if not st: sys.exit("no stage receipt for this run")
    d = st["dir"]; attempt(f"minipc-rollback-{run}", d)
    r = register_task(f"EnclaveTunnelRollback-{run}", "rollback", d, None, st["hashes"])
    print(r)
    if not r.get("argsMatch"): sys.exit("the rollback task is not exactly the pinned launcher: NOT started; root inspects")
    print("start:", start_task(f"EnclaveTunnelRollback-{run}"))
    res = poll_decision(d, "rollback")
    if ((res or {}).get("receipt") or {}).get("decision") or (res or {}).get("launcher"): drop_task(f"EnclaveTunnelRollback-{run}")
    print(json.dumps(res, indent=1)[:3000]); rec(f"minipc-rollback-{run}", res or {})
    dec = ((res or {}).get("receipt") or {}).get("decision") or ""
    if dec not in ("rolled-back", "nothing-to-roll-back"):
        sys.exit(f"rollback NOT complete ({dec or 'UNKNOWN'}): do not retry blindly; read receipt-rollback.json conflicts")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a: sys.exit(__doc__)
    c, rest = a[0], a[1:]
    fn = {"pin": cmd_pin, "vm-preflight": cmd_vm_preflight, "minipc-preflight": cmd_minipc_preflight,
          "minipc-candidate-check": cmd_minipc_candidate_check, "minipc-sandbox-test": cmd_minipc_sandbox_test,
          "minipc-parse-check": cmd_minipc_parse_check,
          "minipc-stage": cmd_minipc_stage, "minipc-apply": cmd_minipc_apply, "vm-apply": cmd_vm_apply, "vm-enable": cmd_vm_enable,
          "verify": cmd_verify, "minipc-confirm": cmd_minipc_confirm, "vm-rollback": cmd_vm_rollback, "minipc-rollback": cmd_minipc_rollback}.get(c)
    if not fn: sys.exit(__doc__)
    if rest and not re.fullmatch(r"[a-z0-9]{6,16}", rest[0]): sys.exit("RUN must be 6-16 lowercase letters/digits (transport limit)")
    fn(*rest)
