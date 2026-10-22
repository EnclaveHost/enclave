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
# W2 job-wide committed-memory cap: jobMemoryMiB=300; three children each commit 120 MiB in 10 MiB steps and hold it for
# 8 s. Each alone is far below 300 MiB, so a refusal proves the cap is JOB-wide (runner + all children), not per process.
# While they hold, the harness samples every process of the tree (private bytes = commit charge) to cross-check the job.
$run = "$V\runs\w2"
$p = Start-Sup $run
$maxSum = 0; $maxAt = $null
$end = (Get-Date).AddSeconds(90)
while (-not $p.HasExited -and (Get-Date) -lt $end) {
  $tree = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -eq $Node })
  $mib = @(foreach ($x in $tree) { $g = Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue; if ($g) { [ordered]@{ pid = [int]$x.ProcessId; privateMiB = [math]::Round($g.PrivateMemorySize64 / 1MB) } } })
  $sum = 0; foreach ($m in $mib) { $sum += $m.privateMiB }
  if ($sum -gt $maxSum) { $maxSum = $sum; $maxAt = $mib }
  Start-Sleep -Milliseconds 200
}
$exited = $p.HasExited
$allocs = @(foreach ($i in 0..2) { $f = "$run\state\child-$i.json"; if (Test-Path $f) { (Read-Json $f).alloc } else { [ordered]@{ ok = $false; gotMiB = 0; error = 'no report (the child could not start or was ended)' } } })
$log = Text "$run\state\supervisor.log"
$peak = if ($log -match 'job peak committed memory (\d+) MiB') { [int]$Matches[1] } else { -1 }
Check 'W2 the first 120 MiB commit succeeds' ($allocs[0].ok -eq $true) $allocs[0]
Check 'W2 a later commit is refused by the 300 MiB job limit' (@($allocs[1..2] | Where-Object { $_.ok -ne $true }).Count -ge 1) @($allocs)
Check 'W2 the job peak stayed within the 300 MiB limit' ($peak -gt 0 -and $peak -le 300) ([ordered]@{ peakMiB = $peak; exited = $exited })
Check 'W2 sampled commit of the whole tree never exceeded 300 MiB' ($maxSum -gt 0 -and $maxSum -le 300) ([ordered]@{ maxSumMiB = $maxSum; at = $maxAt })
Done
