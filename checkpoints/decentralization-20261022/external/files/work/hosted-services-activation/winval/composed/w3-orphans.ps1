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
# W3 KILL_ON_JOB_CLOSE: the runner exits 0 while its 3 children still run (on Linux they survive: harness-local); the
# supervisor closes the job and the job must end them. Nothing is force-killed by this script. The children are spawned
# DETACHED, so libuv does not also put them in its own kill-on-close job: only the supervisor's job can end them.
$run = "$V\runs\w3"
$p = Start-Sup $run
Check 'W3 runner exited 0 leaving children' (Wait-Until { (Text "$run\state\fake-runner.log") -match 'WITHOUT stopping the children' } 60) $null
$r = Read-Json "$run\state\runner.json"
$exited = Wait-Until { $p.HasExited } 30
Check 'W3 supervisor treated the clean exit as final (exit 0)' ($exited -and $p.ExitCode -eq 0 -and (Text "$run\state\supervisor.log") -match 'runner exited cleanly') ([ordered]@{ exitCode = $(if ($exited) { $p.ExitCode } else { $null }) })
$gone = Wait-Until { @(@($r.children) | Where-Object { Alive $_ }).Count -eq 0 } 10
Check 'W3 the job reaped all 3 orphaned children on close' $gone ([ordered]@{ children = @($r.children); stillAlive = @(@($r.children) | Where-Object { Alive $_ }) })
Done
