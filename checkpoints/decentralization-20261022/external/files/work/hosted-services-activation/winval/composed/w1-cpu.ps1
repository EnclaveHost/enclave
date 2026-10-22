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
# W1 CPU-rate hard cap: one child spins 4 s wall time, first under cpuPercent=50 (of one logical CPU), then under 1600
# (no effective cap on 16 CPUs). At most one core for 4 s each: no disruption.
$out = [ordered]@{}
foreach ($k in 'cpu50', 'cpu1600') {
  $run = "$V\runs\w1-$k"
  $p = Start-Sup $run
  $null = Wait-Until { $p.HasExited } 60
  $f = "$run\state\child-0.json"
  $out[$k] = if (Test-Path $f) { (Read-Json $f).cpu } else { $null }
}
$frac = { param($c) if ($c) { ($c.userMs + $c.systemMs) / [double]$c.wallMs } else { -1 } }
$capped = & $frac $out.cpu50; $free = & $frac $out.cpu1600
Check 'W1 CPU hard cap: the 50% job used at most ~0.6 of one CPU, the uncapped job ~1' (($capped -gt 0) -and ($capped -le 0.65) -and ($free -ge 0.8)) ([ordered]@{ cpu50 = $out.cpu50; cpu1600 = $out.cpu1600; fraction50 = [math]::Round($capped, 3); fraction1600 = [math]::Round($free, 3) })
Done
