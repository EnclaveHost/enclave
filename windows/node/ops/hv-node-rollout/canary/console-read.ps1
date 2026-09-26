# console-read.ps1 - READ-ONLY: capture a partition's COM1 console (the guest's serial: MON and DOM lines) for a bounded
# time, into a file, for the v41 canary checks (CANARY-v41.md). It changes nothing on the VM: it is one more client of the
# named pipe Hyper-V serves COM1 on, the same way the launcher's readConsole reads it (wmi-launcher.mjs), and it lets go
# at the end.
#   powershell -ExecutionPolicy Bypass -File console-read.ps1 -VmName enclave-app-<instance> -Seconds 120 -OutFile <file>
# A named pipe has ONE client at a time. The launcher attaches at Start-VM and reads until the monitor's ready line, so
# this retries the connect (each try bounded by -ConnectMs) until -WaitSec, and never races the launcher for the pipe:
# start it right after the launcher step. Bytes are written RAW (no decoding), so a grep sees exactly what the guest sent.
param(
  [Parameter(Mandatory = $true)][string]$VmName,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$Seconds = 120, [int]$WaitSec = 60, [int]$ConnectMs = 1000
)
$ErrorActionPreference = 'Stop'
$pipe = [string](Get-VMComPort -VMName $VmName -Number 1).Path
if ($pipe -notmatch '^\\\\\.\\pipe\\(.+)$') { Write-Output "REFUSED: COM1 of $VmName is not a named pipe ($pipe)"; exit 2 }
$name = $Matches[1]
$out = [System.IO.File]::Open($OutFile, 'Create', 'Write', 'Read')
$cli = $null; $total = 0; $connected = $false; $why = ''
try {
  $deadlineConnect = (Get-Date).AddSeconds($WaitSec)
  while (-not $connected -and (Get-Date) -lt $deadlineConnect) {
    try {
      $cli = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::In, [System.IO.Pipes.PipeOptions]::Asynchronous)
      $cli.Connect($ConnectMs); $connected = $true
    } catch { if ($cli) { $cli.Dispose(); $cli = $null }; Start-Sleep -Milliseconds 500 }
  }
  if (-not $connected) { $why = "could not attach to $pipe within $WaitSec s (another client holds it?)" }
  else {
    $buf = New-Object byte[] 4096; $pending = $null
    $end = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $end) {
      if ($null -eq $pending) { $pending = $cli.ReadAsync($buf, 0, $buf.Length) }
      if (-not $pending.Wait(500)) { continue }
      $n = $pending.Result; $pending = $null
      if ($n -le 0) { $why = 'the VM closed its console'; break }
      $out.Write($buf, 0, $n); $out.Flush(); $total += $n
    }
  }
} finally {
  if ($cli) { try { $cli.Dispose() } catch {} }
  $out.Dispose()
}
Write-Output ("console-read: {0} connected={1} bytes={2} file={3} {4}" -f $VmName, $connected, $total, $OutFile, $why)
if (-not $connected) { exit 1 }
