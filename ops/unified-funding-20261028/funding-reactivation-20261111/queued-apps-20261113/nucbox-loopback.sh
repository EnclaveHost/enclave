#!/usr/bin/env bash
# The NucBox's Windows loopback-exemption list (CheckNetIsolation LoopbackExempt) and the stale entries in it.
#
#   nucbox-loopback.sh status   read only: how many exemptions, how many of an AppContainer that no longer exists
#   nucbox-loopback.sh prune    removes the exemptions whose AppContainer no longer exists, one by one; a named
#                               (existing) AppContainer's exemption is never touched, nor is that of a circuit whose
#                               process is running; stops if Windows refuses the first three
#   nucbox-loopback.sh agent    ends the network agent; the \Enclave\Network task starts a new one, which builds every
#                               circuit again (and forgets the edges it had put on hold after failed circuits). The
#                               apps' VMs are not touched. Reports the circuits and the apps' egress afterwards.
#
# Why: the list holds 682 entries at most (2026-10-14 and again 2026-11-14: 682 listed, 675/676 of them stale). When it
# is full, `LoopbackExempt -a` exits 87, the network agent's circuit helper panics, and the app's tunnel process exits:
# the app has no route. The helper's own pruning (network/windows-firewall/loopback.go) ran at every refusal and the
# count did not fall.
# 2026-11-14 04:50Z: the listing read from an administrator's session names "AppContainer NOT FOUND" for the running
# circuits of the agent too (the agent runs as SYSTEM). The first prune removed all 676 such entries, the running
# circuits' among them: within 40 s every app circuit failed its probes and the apps' egress went OFF. Since then prune
# skips the SID in firewall.json of every circuit directory that has a running process.
set -euo pipefail
mode=${1:-status}
case "$mode" in status|prune|agent) ;; *) echo "usage: $0 status|prune|agent" >&2; exit 2;; esac
# the mode travels as the script's first line: a variable in the remote command line does not survive the Windows shell
{ printf "\$mode='%s'\n" "$mode"; cat <<'E'
$ErrorActionPreference='SilentlyContinue'
$tool="$env:SystemRoot\System32\CheckNetIsolation.exe"
function Entries {
  $name=''; $out=@()
  foreach($raw in (& $tool LoopbackExempt -s)){
    $line=([string]$raw).Trim()
    if($line.StartsWith('Name:')){ $name=$line.Substring(5).Trim() }
    elseif($line.StartsWith('SID:')){ $out+=New-Object psobject -Property @{Name=$name;SID=$line.Substring(4).Trim()}; $name='' }
    elseif($line.StartsWith('[') -or $line -eq ''){ $name='' }
  }
  return $out
}
function Stale($all){ @($all | Where-Object { $_.Name -ieq 'AppContainer NOT FOUND' -and $_.SID -match '^S-1-15-2-[0-9-]+$' }) }
function Show($label,$st,$all){ "$label $((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))Z: $($all.Count) exemptions, $($st.Count) of an AppContainer that no longer exists, $($all.Count-$st.Count) other" }
$all=@(Entries); $st=@(Stale $all); Show 'list' $st $all
$private='key|secret|token|password'
function Circuits { @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -match '\\network-circuits\\enclave-circuit-[a-f0-9]{32}\\' }) }
if($mode -eq 'agent'){
  $log='C:\ProgramData\Enclave\logs\network.log'
  function Agents { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'privacy-agent\.mjs' }) }
  function Since($mark){ $fs=[IO.File]::Open($log,'Open','Read','ReadWrite'); $n=[Math]::Max(0,$fs.Length-$mark); $null=$fs.Seek($mark,'Begin'); $b=New-Object byte[] $n; $null=$fs.Read($b,0,$n); $fs.Close(); @([Text.Encoding]::UTF8.GetString($b) -split "`n" | Where-Object { $_ -notmatch $private }) }
  $was=@(Agents | ForEach-Object { $_.ProcessId })
  if($was.Count -ne 1){ "STOP: expected one network agent, found $($was.Count); nothing changed"; return }
  $mark=(Get-Item -LiteralPath $log).Length
  "ending the network agent, pid $($was[0]) $((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))Z"
  Stop-Process -Id $was[0] -Force
  $new=$null
  for($i=0; $i -lt 90 -and -not $new; $i+=3){ Start-Sleep -Seconds 3; $new=Agents | Where-Object { $was -notcontains $_.ProcessId } | Select-Object -First 1 }
  if(-not $new){ "STOP: no new agent process within 90 s"; return }
  "network agent started, pid $($new.ProcessId) $((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))Z"
  $up=$false
  for($i=0; $i -lt 180 -and -not $up; $i+=5){ Start-Sleep -Seconds 5; $up=[bool](@(Since $mark) -match 'control circuit up') }
  "control circuit up: $up"
  Start-Sleep -Seconds 75
  $t=@(Since $mark)
  "since the restart: $(@($t -match 'egress back').Count) egress back, $(@($t -match 'egress OFF').Count) egress OFF, $(@($t -match 'panic: exit status').Count) helper refusals, $(@($t -match 'tunnel process exited').Count) tunnel exits"
  $t | Where-Object { $_ -match 'egress back|egress OFF|control circuit|chain authorization|config reloaded' } | Select-Object -Last 14 | ForEach-Object { '  ' + ($_ -replace '[0-9a-fA-F]{24,}','(masked)').TrimEnd() }
  "circuit processes: $(@(Circuits).Count)"
  $all=@(Entries); Show 'list after' @(Stale $all) $all
  if(@(Agents | Where-Object { $_.ProcessId -eq $new.ProcessId }).Count -ne 1){ "STOP: the new agent did not stay up"; return }
  "DONE agent"; return
}
if($mode -ne 'prune'){ "DONE status"; return }
# never an exemption a running circuit needs: read from this session, those are listed as NOT FOUND too
$live=@{}
foreach($p in Circuits){ $j=Get-Content -Raw -LiteralPath (Join-Path (Split-Path $p.ExecutablePath -Parent) 'firewall.json') | ConvertFrom-Json; if($j.appContainerSid){ $live[[string]$j.appContainerSid]=1 } }
$running=@(Circuits).Count
if($running -gt 0 -and $live.Count -eq 0){ "STOP: $running circuit process(es) run and none of their SIDs could be read; nothing removed"; return }
$st=@($st | Where-Object { -not $live.ContainsKey($_.SID) })
"$($live.Count) SID(s) of running circuits are kept; $($st.Count) to remove"
$ok=0; $refused=0; $n=0
foreach($e in $st){
  $n++
  $null=& $tool LoopbackExempt -d "-p=$($e.SID)" 2>&1
  if($LASTEXITCODE -eq 0){ $ok++ } else { $refused++; if($refused -le 3){ "refused (exit $LASTEXITCODE) for entry $n" } }
  if($n -eq 3 -and $ok -eq 0){ "Windows refused the first three removals: stopping, nothing removed"; break }
  if($n % 100 -eq 0){ "$n tried, $ok removed, $refused refused" }
}
"tried $n, removed $ok, refused $refused"
$all=@(Entries); Show 'list after' @(Stale $all) $all
"DONE prune"
E
} | ssh -o BatchMode=yes -o ConnectTimeout=15 minipc 'powershell -NoProfile -Command "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"' 2>&1 | sed '/post-quantum\|store now\|openssh.com\/pq/d'
