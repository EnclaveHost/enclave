#!/usr/bin/env python3
"""READ-ONLY minipc recovery-path probe (reviewer 9d, 2026-10-21). ROOT RUNS IT; never run by its author.
  python3 recovery-probe.py            -> runs the 7 read-only steps over root's reviewed transport, writes out-<ts>.json
                                          (O_EXCL), prints the gate summary
  python3 recovery-probe.py --texts    -> prints each step's PowerShell (nothing is sent)
  python3 recovery-probe.py --gates F  -> re-evaluates the gates of an existing out-<ts>.json (nothing is sent)
Transport: nucbox-tls-20261021/root-activate-reviewed.py m.ps, loaded only if its sha is the pin (ssh -n BatchMode, the host
alias `minipc` = claude@192.168.8.238:22 per root's ssh -G; EncodedCommand <= 7900; in-session 512 MB/time watchdog).
Each step is a NEW ssh connection, i.e. the path a recovery uses.
Reads ONLY metadata:
  - this SSH session: SSH_CONNECTION, the :22 sockets, the server address's interface/origin/lifetime, the route back to
    the client;
  - adapters (no MAC), IPv4 addresses, default routes, connection profiles, Hyper-V switches;
  - sshd service/binary/version, the sshd_config SHA ONLY, the sshd process tree, SCM failure actions, the OpenSSH firewall
    rule + profiles;
  - existing alternative listeners (RDP/WinRM: service state + sockets only);
  - tunnel-cutover artefacts by presence;
  - \\Enclave\\ and \\EnclaveOps\\ task states/triggers/next runs; node/network/manager/updater process identities;
  - the installed release version, release-policy PRESENCE, updater hashes, update.log timestamps/versions only, the
    hosting\\update.json state, pending-reboot flags.
Never: keys or key files, sshd_config/privacy/node config contents, env dumps, log lines, writes, starts or stops."""
import base64, calendar, hashlib, importlib.util, json, os, pathlib, sys, time
W = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work")
T = (W / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
HERE = pathlib.Path(__file__).resolve().parent
LAN_IP, LAN_PORT = "192.168.8.238", 22                     # root's ssh -G minipc (direct; no ProxyJump/ProxyCommand)
SSHD_CONFIG = "99f373a06dfa706f0a8a98d655c776850305b4b1ea3bf9a33fa926897bb15649"   # tunnel receipts 21:39Z..21:58Z (unchanged)
WINDOW_S = 600 + 900 + 60                                  # node cutover: preflight validity + bound + 60 s (root-node-hold.py)
U = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o')};"
ISO = ".ToUniversalTime().ToString('o')"
E = "[string]$_.Exception.Message"

STEPS = {}
STEPS["session"] = U + r"""$sc=[string]$env:SSH_CONNECTION;$o.sshConnection=$sc;$p=@($sc -split ' ');
try{$id=[Security.Principal.WindowsIdentity]::GetCurrent();$o.user=$id.Name;$o.admin=(New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}catch{$o.user=EX};
try{$o.listen22=@(Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction Stop|ForEach-Object{[ordered]@{addr=[string]$_.LocalAddress;pid=[int]$_.OwningProcess}})}catch{$o.listen22=EX};
try{$e=@(Get-NetTCPConnection -LocalPort 22 -State Established -ErrorAction Stop);$o.established22=$e.Count;
 $o.thisSession=@($e|Where-Object{$p.Count -eq 4 -and [string]$_.RemoteAddress -eq $p[0] -and [string]$_.RemotePort -eq $p[1] -and [string]$_.LocalAddress -eq $p[2]}|ForEach-Object{[ordered]@{local=[string]$_.LocalAddress;localPort=[int]$_.LocalPort;remote=[string]$_.RemoteAddress;remotePort=[int]$_.RemotePort;pid=[int]$_.OwningProcess}})}catch{$o.established22=EX};
if($p.Count -eq 4){try{$ip=@(Get-NetIPAddress -IPAddress $p[2] -ErrorAction Stop)[0];$o.serverIf=[ordered]@{ifIndex=[int]$ip.InterfaceIndex;alias=[string]$ip.InterfaceAlias;prefixLength=[int]$ip.PrefixLength;prefixOrigin=[string]$ip.PrefixOrigin;suffixOrigin=[string]$ip.SuffixOrigin;validLifetimeSec=[int64]$ip.ValidLifetime.TotalSeconds;state=[string]$ip.AddressState}}catch{$o.serverIf=EX};
 try{$o.routeToClient=@(Find-NetRoute -RemoteIPAddress $p[0] -ErrorAction Stop|Where-Object{$_.DestinationPrefix}|ForEach-Object{[ordered]@{prefix=[string]$_.DestinationPrefix;ifIndex=[int]$_.InterfaceIndex;nextHop=[string]$_.NextHop;metric=[int]$_.RouteMetric}})}catch{$o.routeToClient=EX}};
$o|ConvertTo-Json -Compress -Depth 5""".replace("EX", E)

STEPS["network"] = U + r"""try{$o.adapters=@(Get-NetAdapter -ErrorAction Stop|ForEach-Object{[ordered]@{name=[string]$_.Name;desc=[string]$_.InterfaceDescription;ifIndex=[int]$_.ifIndex;status=[string]$_.Status;hardware=[bool]$_.HardwareInterface;virtual=[bool]$_.Virtual;speed=[string]$_.LinkSpeed}})}catch{$o.adapters=EX};
try{$o.ipv4=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop|Where-Object{[string]$_.IPAddress -notlike '127.*'}|ForEach-Object{[ordered]@{ip=[string]$_.IPAddress;prefixLength=[int]$_.PrefixLength;ifIndex=[int]$_.InterfaceIndex;alias=[string]$_.InterfaceAlias;origin=[string]$_.PrefixOrigin}})}catch{$o.ipv4=EX};
try{$o.defaultRoutes=@(Get-NetRoute -DestinationPrefix '0.0.0.0/0','::/0' -ErrorAction SilentlyContinue|ForEach-Object{[ordered]@{prefix=[string]$_.DestinationPrefix;ifIndex=[int]$_.InterfaceIndex;alias=[string]$_.InterfaceAlias;nextHop=[string]$_.NextHop;routeMetric=[int]$_.RouteMetric;ifMetric=[int]$_.InterfaceMetric;protocol=[string]$_.Protocol;store=[string]$_.Store}})}catch{$o.defaultRoutes=EX};
try{$o.profiles=@(Get-NetConnectionProfile -ErrorAction Stop|ForEach-Object{[ordered]@{alias=[string]$_.InterfaceAlias;ifIndex=[int]$_.InterfaceIndex;category=[string]$_.NetworkCategory;ipv4=[string]$_.IPv4Connectivity}})}catch{$o.profiles=EX};
try{$o.vmSwitches=@(Get-VMSwitch -ErrorAction Stop|ForEach-Object{[ordered]@{name=[string]$_.Name;type=[string]$_.SwitchType;adapter=[string]$_.NetAdapterInterfaceDescription;mgmtOS=[bool]$_.AllowManagementOS}})}catch{$o.vmSwitches=EX};
$o|ConvertTo-Json -Compress -Depth 5""".replace("EX", E)

STEPS["sshd"] = U + r"""try{$s=Get-CimInstance Win32_Service -Filter "Name='sshd'" -OperationTimeoutSec 20 -ErrorAction Stop;$o.service=[ordered]@{state=[string]$s.State;startMode=[string]$s.StartMode;delayed=[bool]$s.DelayedAutoStart;pid=[int]$s.ProcessId;path=[string]$s.PathName}}catch{$o.service=EX};
$x='C:\Windows\System32\OpenSSH\sshd.exe';$o.sshdExe=FileSha $x;try{$o.sshdVersion=[string](Get-Item -LiteralPath $x -ErrorAction Stop).VersionInfo.ProductVersion}catch{$o.sshdVersion=EX};
$o.sshdConfigSha=FileSha 'C:\ProgramData\ssh\sshd_config';
try{$o.sshdProcs=@(Get-CimInstance Win32_Process -Filter "Name like 'sshd%'" -OperationTimeoutSec 20 -ErrorAction Stop|ForEach-Object{[ordered]@{name=[string]$_.Name;pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;session=[int]$_.SessionId;start=$_.CreationDate.ToUniversalTime().ToString('o')}})}catch{$o.sshdProcs=EX};
try{$q=& {$ErrorActionPreference='Continue';& "$env:SystemRoot\System32\sc.exe" qfailure sshd 2>&1};$o.failureActions=@($q|ForEach-Object{([string]$_).Trim()}|Where-Object{$_ -match '^(RESET_PERIOD|REBOOT_MESSAGE|COMMAND_LINE|FAILURE_ACTIONS|RESTART|RUN PROCESS|REBOOT)'})}catch{$o.failureActions=EX};
try{$r=Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction Stop;$o.fwRule=[ordered]@{enabled=[string]$r.Enabled;action=[string]$r.Action;direction=[string]$r.Direction;profile=[string]$r.Profile;localPort=@(($r|Get-NetFirewallPortFilter).LocalPort|ForEach-Object{[string]$_});remote=@(($r|Get-NetFirewallAddressFilter).RemoteAddress|ForEach-Object{[string]$_})}}catch{$o.fwRule=EX};
try{$o.fwProfiles=@(Get-NetFirewallProfile -ErrorAction Stop|ForEach-Object{[ordered]@{name=[string]$_.Name;enabled=[string]$_.Enabled;inbound=[string]$_.DefaultInboundAction}})}catch{$o.fwProfiles=EX};
$o|ConvertTo-Json -Compress -Depth 5""".replace("EX", E)

STEPS["alternatives"] = U + r"""foreach($n in 'TermService','WinRM'){try{$s=Get-CimInstance Win32_Service -Filter "Name='$n'" -OperationTimeoutSec 20 -ErrorAction Stop;$o[$n]=[ordered]@{state=[string]$s.State;startMode=[string]$s.StartMode}}catch{$o[$n]=EX}};
try{$o.rdpDenied=[int](Get-ItemProperty -LiteralPath 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -ErrorAction Stop).fDenyTSConnections}catch{$o.rdpDenied=EX};
$o.listeners=[ordered]@{};foreach($pt in 3389,5985,5986,31053){$o.listeners[[string]$pt]=@(Get-NetTCPConnection -LocalPort $pt -State Listen -ErrorAction SilentlyContinue|ForEach-Object{[string]$_.LocalAddress})};
$o.tunnelUser=[bool](Get-LocalUser -Name 'enc-ctl-tunnel' -ErrorAction SilentlyContinue);$o.tunnelKeys=Test-Path -LiteralPath 'C:\ProgramData\ssh\enc-ctl-tunnel_authorized_keys';
$o.tunnelTasks=@(Get-ScheduledTask -ErrorAction SilentlyContinue|Where-Object{$_.TaskName -like 'EnclaveTunnel*'}|ForEach-Object{$_.TaskName+'='+[string]$_.State});
$o.tunnelStaging=@(Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave\staging' -Directory -Filter 'tunnel-*' -ErrorAction SilentlyContinue).Count;
$o.tunnelBackups=@(Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave\backup' -Directory -Filter 'tunnel-*' -ErrorAction SilentlyContinue).Count;
$o|ConvertTo-Json -Compress -Depth 5""".replace("EX", E)

STEPS["tasks"] = U + r"""$o.tasks=@(foreach($tp in '\Enclave\','\EnclaveOps\'){Get-ScheduledTask -TaskPath $tp -ErrorAction SilentlyContinue|ForEach-Object{$t=$_;$i=$null;try{$i=Get-ScheduledTaskInfo -InputObject $t -ErrorAction Stop}catch{};$a=@($t.Actions)[0]
 [ordered]@{path=$tp;name=$t.TaskName;state=[string]$t.State;enabled=[bool]$t.Settings.Enabled;user=[string]$t.Principal.UserId;
  triggers=@($t.Triggers|Where-Object{$_}|ForEach-Object{[ordered]@{kind=([string]$_.CimClass.CimClassName -replace '^MSFT_Task','' -replace 'Trigger$','');enabled=[bool]$_.Enabled;delay=[string]$_.Delay;every=[string]$_.Repetition.Interval}});
  exe=[string]$a.Execute;args=$(([string]$a.Arguments)+'').Substring(0,[math]::Min(120,(([string]$a.Arguments)+'').Length));
  last=$(if($i -and $i.LastRunTime){$i.LastRunTime.ToUniversalTime().ToString('o')}else{$null});lastResult=$(if($i){[int64]$i.LastTaskResult}else{$null});
  next=$(if($i -and $i.NextRunTime){$i.NextRunTime.ToUniversalTime().ToString('o')}else{$null})}}});
$o|ConvertTo-Json -Compress -Depth 6"""

STEPS["processes"] = U + r"""$all=@(Get-CimInstance Win32_Process -OperationTimeoutSec 30);function Id($p){"$($p.ProcessId)@$($p.CreationDate.ToUniversalTime().ToString('o'))<$($p.ParentProcessId)"}
function Pick($n,$pat){@($all|Where-Object{$_.Name -eq $n -and [string]$_.CommandLine -like $pat}|ForEach-Object{Id $_})}
$o.nodeCmd=Pick 'cmd.exe' '*\Enclave\run-node.cmd*';$o.nodeAgent=Pick 'node.exe' '*\control\windows\node\agent.mjs*';
$o.networkCmd=Pick 'cmd.exe' '*\Enclave\run-network.cmd*';$o.privacy=Pick 'node.exe' '*privacy-agent.mjs*';
$o.shieldCmd=Pick 'cmd.exe' '*\Enclave\run-shield.cmd*';$o.updater=Pick 'powershell.exe' '*update-host.ps1*';$o.installer=Pick 'powershell.exe' '*install-host.ps1*';
$o.wg=@($all|Where-Object{$_.Name -eq 'enclave-wg.exe'}).Count;$o.firewallSandboxes=@($all|Where-Object{$_.Name -eq 'enclave-circuit-firewall.exe'}).Count;
$c=@(Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue);$o.manager=@($c|ForEach-Object{$q=$_.OwningProcess;$all|Where-Object{$_.ProcessId -eq $q}|ForEach-Object{Id $_}});
try{$b=(Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 20 -ErrorAction Stop).LastBootUpTime;$o.lastBoot=$b.ToUniversalTime().ToString('o')}catch{$o.lastBoot=EX};
$o|ConvertTo-Json -Compress -Depth 4""".replace("EX", E)

STEPS["update"] = U + r"""$pf='C:\Program Files\Enclave';$pd='C:\ProgramData\Enclave';
try{$o.installedVersion=[string]([IO.File]::ReadAllText((Join-Path $pf 'manifest.json'))|ConvertFrom-Json).version}catch{$o.installedVersion=EX};
$o.releasePolicy=Test-Path -LiteralPath (Join-Path $pd 'node\release-policy.json');$o.hostRecord=Test-Path -LiteralPath (Join-Path $pd 'node\host.json');
$o.updateHost=FileSha (Join-Path $pf 'update-host.ps1');$o.installHost=FileSha (Join-Path $pf 'install-host.ps1');
$lg=Join-Path $pd 'logs\update.log';if(Test-Path -LiteralPath $lg){$it=Get-Item -LiteralPath $lg;$o.updateLog=[ordered]@{bytes=[int64]$it.Length;written=$it.LastWriteTimeUtc.ToString('o')};
 $l=@(Get-Content -LiteralPath $lg -Tail 4000);$o.updateLog.attempts=@($l|ForEach-Object{if($_ -match '^(\S+Z) update (\S+) -> (\S+) for '){"$($matches[1]) $($matches[2])->$($matches[3])"}}|Select-Object -Last 5);
 $o.updateLog.updated=@($l|ForEach-Object{if($_ -match '^(\S+Z) updated to (\S+)$'){"$($matches[1]) $($matches[2])"}}|Select-Object -Last 3);
 $o.updateLog.failed=@($l|ForEach-Object{if($_ -match '^(\S+Z) (update failed|install of \S+ FAILED)'){$matches[1]}}|Select-Object -Last 3)}else{$o.updateLog='absent'};
try{$u=[IO.File]::ReadAllText((Join-Path $pd 'hosting\update.json'))|ConvertFrom-Json;$o.updateState=[ordered]@{state=[string]$u.state;from=[string]$u.from;to=[string]$u.to;at=[string]$u.at}}catch{$o.updateState='absent'};
$o.rebootPending=[ordered]@{wu=Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired';cbs=Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending';
 rename=[bool](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue)};
$o|ConvertTo-Json -Compress -Depth 5""".replace("EX", E)


def ts(s):
    try: return calendar.timegm(time.strptime(str(s)[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception: return None

def gates(out):
    """PASS / FAIL / UNKNOWN per gate, from one probe's outputs. Never 'PASS' on a missing or errored read."""
    g, s, n, d, a, t, p, u = {}, *(out.get(k) or {} for k in ("session", "network", "sshd", "alternatives", "tasks", "processes", "update"))
    err = {k: (v.get("error") if isinstance(v, dict) else "missing") for k in STEPS for v in [out.get(k)] if not isinstance(v, dict) or v.get("error")}
    def put(k, ok, why, steps):     # a gate whose source step failed is UNKNOWN, whatever the partial data says
        if set(steps) & set(err): ok, why = None, f"source step(s) {sorted(set(steps) & set(err))} failed; " + why
        g[k] = {"result": "UNKNOWN" if ok is None else "PASS" if ok else "FAIL", "why": why}
    if err: g["probe"] = {"result": "FAIL", "why": f"steps failed: {err}"}
    me = s.get("thisSession") if isinstance(s.get("thisSession"), list) else None
    put("L1 lanSession", None if me is None else (len(me) == 1 and me[0]["local"] == LAN_IP and me[0]["localPort"] == LAN_PORT),
        f"this SSH session terminates on {me[0]['local']}:{me[0]['localPort']} from {me[0]['remote']}" if me and len(me) == 1 else f"session match {me!r} ({s.get('sshConnection')!r})", ["session"])
    lis = s.get("listen22") if isinstance(s.get("listen22"), list) else None; spid = (d.get("service") or {}).get("pid") if isinstance(d.get("service"), dict) else None
    put("L2 listener", None if lis is None or spid is None else any(x["addr"] in ("0.0.0.0", "::", LAN_IP) and x["pid"] == spid for x in lis),
        f":22 listeners {lis}, sshd service pid {spid}", ["session", "sshd"])
    sv = d.get("service") if isinstance(d.get("service"), dict) else None
    put("L3 sshdService", None if sv is None else sv["state"] == "Running" and sv["startMode"] == "Auto", f"sshd {sv}", ["sshd"])
    put("L4 sshdConfigPinned", None if not d.get("sshdConfigSha") else d["sshdConfigSha"] == SSHD_CONFIG,
        f"sshd_config {str(d.get('sshdConfigSha'))[:12]} vs pinned {SSHD_CONFIG[:12]} (a change = a tunnel step or an operator edit in flight)", ["sshd"])
    si = s.get("serverIf") if isinstance(s.get("serverIf"), dict) else None
    put("L5 addressStable", None if si is None else si["state"] == "Preferred" and (si["prefixOrigin"] != "Dhcp" or si["validLifetimeSec"] >= 2 * 3600),
        f"server address on ifIndex {si and si['ifIndex']} ({si and si['alias']}), origin {si and si['prefixOrigin']}, valid {si and si['validLifetimeSec']} s", ["session"])
    rt = s.get("routeToClient") if isinstance(s.get("routeToClient"), list) else None
    put("L6 returnPath", None if rt is None or si is None else bool(rt) and all(r["ifIndex"] == si["ifIndex"] for r in rt),
        f"route(s) back to the client {rt} vs the session interface {si and si['ifIndex']}", ["session"])
    fw, profs = d.get("fwRule"), n.get("profiles")
    cat = next((x["category"] for x in (profs if isinstance(profs, list) else []) if si and x["ifIndex"] == si["ifIndex"]), None)
    fwok = None
    if isinstance(fw, dict) and cat:
        fwok = fw["enabled"] == "True" and fw["action"] == "Allow" and (fw["profile"] == "Any" or {"DomainAuthenticated": "Domain"}.get(cat, cat) in fw["profile"])
    put("L7 firewallRule", fwok, f"OpenSSH rule {fw} on a {cat} profile (absent/unreadable = root reads the inbound rules)", ["sshd", "network", "session"])
    tun = [a.get("tunnelUser"), a.get("tunnelKeys"), bool(a.get("tunnelTasks")), bool((a.get("listeners") or {}).get("31053")), bool(a.get("tunnelBackups"))]
    put("T1 tunnelQuiet", None if "tunnelUser" not in a else not any(tun),
        f"user/keys/tasks/31053/backups = {tun}: no tunnel step may be in flight during the node cutover", ["alternatives"])
    tl = t.get("tasks") if isinstance(t.get("tasks"), list) else None; at = ts(u.get("at") or t.get("at"))
    up = next((x for x in tl or [] if x["path"] == "\\Enclave\\" and x["name"] == "Update"), None)
    nx = ts(up["next"]) if up and up.get("next") else None
    put("U1 updaterIdle", None if tl is None or at is None else (up is None or (up["state"] != "Running" and (nx is None or nx >= at + WINDOW_S))) and not p.get("updater") and not p.get("installer"),
        f"\\Enclave\\Update {up and {k: up[k] for k in ('state', 'enabled', 'next', 'lastResult')}}; updater/installer processes {p.get('updater')}/{p.get('installer')}", ["tasks", "processes", "update"])
    put("U2 noNewerRelease", None, f"installed {u.get('installedVersion')}, signed policy present {u.get('releasePolicy')}: ROOT compares with its channel's latest (not readable without a remote fetch)", ["update"])
    rb = u.get("rebootPending") if isinstance(u.get("rebootPending"), dict) else None
    put("B1 noPendingReboot", None if rb is None else not any(rb.values()), f"pending-reboot flags {rb}; last boot {p.get('lastBoot')}", ["update", "processes"])
    node = next((x for x in tl or [] if x["path"] == "\\Enclave\\" and x["name"] == "Node"), None)
    put("B2 bootStartsNode", None if node is None else not any(tr["kind"] == "Boot" and tr["enabled"] for tr in node["triggers"]) or not node["enabled"],
        f"\\Enclave\\Node enabled {node and node['enabled']}, triggers {node and node['triggers']} (FAIL = a reboot starts the node outside any coordinator: expected, informational)", ["tasks"])
    alt = {"rdp": [a.get("TermService"), a.get("rdpDenied"), (a.get("listeners") or {}).get("3389")], "winrm": [a.get("WinRM"), (a.get("listeners") or {}).get("5985"), (a.get("listeners") or {}).get("5986")]}
    put("A1 independentAdminPath", None, f"existing listeners/services {alt}: whether root can actually use one (account, network reach) is root's knowledge; nothing assumed", ["alternatives"])
    return g


def enc_len(text, secs=120):
    """exactly the transport's check (root-activate-reviewed.py ps): HEAD + text, UTF-16LE, base64"""
    return len(base64.b64encode((m.HEAD.replace("SECS", str(secs)) + text).encode("utf-16-le")))

m = None
def load_transport():
    global m
    if hashlib.sha256(T[0].read_bytes()).hexdigest() != T[1]: sys.exit("transport pin differs")
    spec = importlib.util.spec_from_file_location("t", T[0]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def main(argv):
    if argv[:1] == ["--texts"]:
        for k, v in STEPS.items(): print(f"# ---- {k}\n{v}\n")
        return 0
    if argv[:1] == ["--gates"]:
        print(json.dumps(gates(json.loads(pathlib.Path(argv[1]).read_text())["steps"]), indent=1)); return 0
    load_transport()
    for k, v in STEPS.items():
        if enc_len(v) > 7900: sys.exit(f"step {k} does not fit the transport ({enc_len(v)})")
    out = {k: m.ps(v, 120) for k, v in STEPS.items()}
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()); path = HERE / f"out-{stamp}.json"
    g = gates(out)
    with open(path, "x") as fh: json.dump({"what": "recovery-probe", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "steps": out, "gates": g}, fh, indent=1)
    print("receipt:", path); print(json.dumps({k: v["result"] for k, v in g.items()}, indent=1))
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
