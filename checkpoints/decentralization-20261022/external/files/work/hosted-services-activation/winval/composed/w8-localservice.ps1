# Shared by every validation scenario (dot-sourced). Windows PowerShell 5.1. Everything is under the dedicated new root;
# only our own synthetic processes and our own validation task are ever started or stopped.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$V    = 'C:\ProgramData\Enclave\host-services-validation-20261021'
$Node = "$V\node\node.exe"
$Sup  = "$V\bin\hostsvc-supervisor.exe"
$results = [ordered]@{}
function Check([string]$name, [bool]$ok, $detail) { $results[$name] = [ordered]@{ ok = $ok; detail = $detail } }
function Done { [ordered]@{ results = $results } | ConvertTo-Json -Depth 8; if (@($results.Values | Where-Object { -not $_.ok }).Count) { exit 2 } else { exit 0 } }
function Wait-Until([scriptblock]$cond, [int]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { try { if (& $cond) { return $true } } catch { }; Start-Sleep -Milliseconds 300 }
  return $false
}
function Read-Json([string]$p) { Get-Content -Raw -LiteralPath $p | ConvertFrom-Json }
function Text([string]$p) { if (Test-Path -LiteralPath $p) { Get-Content -Raw -LiteralPath $p } else { '' } }
function Start-Sup([string]$run) {
  $p = Start-Process -FilePath $Sup -ArgumentList @('run', "$run\supervisor.json") -PassThru -WindowStyle Hidden
  $null = $p.Handle   # keep the handle so ExitCode stays readable
  $p
}
function Stop-Sup([string]$run) { & $Sup stop "$run\supervisor.json" | Out-Null; $LASTEXITCODE }
function Alive([int]$id) { $null -ne (Get-Process -Id $id -ErrorAction SilentlyContinue) }
function ParentOf([int]$id) { $x = Get-CimInstance Win32_Process -Filter "ProcessId=$id"; if ($x) { [int]$x.ParentProcessId } else { -1 } }
function PortOpen([int]$port) { try { $t = New-Object Net.Sockets.TcpClient; $t.Connect('127.0.0.1', $port); $t.Close(); $true } catch { $false } }
function OurNodes { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -eq $Node }) }
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class WinvalJob {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string InJob(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return "unopenable";
    bool r; bool ok = IsProcessInJob(h, IntPtr.Zero, out r); CloseHandle(h); return ok ? (r ? "in-a-job" : "no-job") : "error";
  }
}
"@
# W8 + W4 from a LOCAL SERVICE scheduled task (our own unique task; no trigger): the supervisor, running as LOCAL SERVICE,
# creates the Global\ stop event (SeCreateGlobalPrivilege); an Administrator opens and sets it; the runner gets CTRL_BREAK
# through the task's console and stops gracefully. The task is then unregistered (it is ours).
$run = "$V\runs\w8"; $name = 'EnclaveHostServicesValidation-20261021-LocalService'
if (Get-ScheduledTask -TaskPath '\' -TaskName $name -ErrorAction SilentlyContinue) { throw "refusing: task $name already exists" }
$action = New-ScheduledTaskAction -Execute $Sup -Argument "run $run\supervisor.json" -WorkingDirectory "$run\state"
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskPath '\' -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
try {
  Start-ScheduledTask -TaskPath '\' -TaskName $name
  $up = Wait-Until { (Test-Path "$run\state\runner.json") -and @((Read-Json "$run\state\runner.json").children).Count -eq 3 } 60
  $log = Text "$run\state\supervisor.log"
  Check 'W8 the LOCAL SERVICE supervisor created its Global stop event and started the runner' ($up -and $log -notmatch 'stop event:') ([ordered]@{ taskState = (Get-ScheduledTask -TaskPath '\' -TaskName $name).State.ToString() })
  $r = if ($up) { Read-Json "$run\state\runner.json" } else { $null }
  $rc = Stop-Sup $run
  Check 'W8 an Administrator opened and set the Global event' ($rc -eq 0) $rc
  $done = Wait-Until { (Get-ScheduledTask -TaskPath '\' -TaskName $name).State.ToString() -ne 'Running' } 45
  $log = Text "$run\state\supervisor.log"; $fake = Text "$run\state\fake-runner.log"
  Check 'W4 from the LOCAL SERVICE task: CTRL_BREAK reached the runner, graceful exit 0' ($done -and $log -match 'runner stopped \(0\)' -and $log -notmatch 'terminating the job' -and $fake -match 'SIGBREAK received') ([ordered]@{ lastTaskResult = (Get-ScheduledTaskInfo -TaskPath '\' -TaskName $name).LastTaskResult })
  if ($r) { Check 'W8 nothing of the tree remains' (Wait-Until { @(@($r.children) + @([int]$r.pid) | Where-Object { Alive $_ }).Count -eq 0 } 10) $null }
} finally {
  if ((Get-ScheduledTask -TaskPath '\' -TaskName $name).State.ToString() -eq 'Running') { Stop-ScheduledTask -TaskPath '\' -TaskName $name }
  Unregister-ScheduledTask -TaskPath '\' -TaskName $name -Confirm:$false
}
Check 'W8 our validation task is unregistered' ($null -eq (Get-ScheduledTask -TaskPath '\' -TaskName $name -ErrorAction SilentlyContinue)) $null
Done
