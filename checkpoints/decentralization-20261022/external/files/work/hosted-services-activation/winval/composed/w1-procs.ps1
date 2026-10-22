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
# W1 job membership, by effect: IsProcessInJob(NULL) is NOT proof here (this PowerShell, and so the supervisor, already
# runs inside the SSH session's job). The w1-procs job allows 3 active processes: the runner + 2 children. The runner
# starts 4 children one by one; if they are in THIS job, exactly the last 2 are refused by the job, not by anything else.
$run = "$V\runs\w1-procs"
$p = Start-Sup $run
$exited = Wait-Until { $p.HasExited } 60
$r = Read-Json "$run\state\runner.json"
Check 'W1 the job admits the runner + 2 children and refuses children 3 and 4 (ActiveProcessLimit 3)' ((@($r.children).Count -eq 2) -and (@($r.refused).Count -eq 2) -and (@($r.refused | ForEach-Object { $_.i }) -join ',') -eq '2,3') ([ordered]@{ spawned = @($r.children); refused = @($r.refused) })
Check 'W1 the supervisor treated the runner''s clean exit as final' ($exited -and $p.ExitCode -eq 0) ([ordered]@{ exitCode = $(if ($exited) { $p.ExitCode } else { $null }) })
Check 'W1 nothing of the tree remains' (Wait-Until { @(@($r.children) + @([int]$r.pid) | Where-Object { Alive $_ }).Count -eq 0 } 10) $null
Done
