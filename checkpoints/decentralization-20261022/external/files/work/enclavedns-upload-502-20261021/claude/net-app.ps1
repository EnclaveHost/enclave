$ErrorActionPreference='Stop'
# READ-ONLY: network.log lines naming the adapter (0x7ae476a3) or sia-s3 (0xef514ed3), from the last 64 MiB; truncated.
$p = Join-Path $env:ProgramData 'Enclave\logs\network.log'
$fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite'); try { [void]$fs.Seek([Math]::Max(0, $fs.Length - 64MB), 'Begin'); $text = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
$all = @($text -split "`n")
Write-Output ("lines in window: {0}; first: {1}" -f $all.Count, ($all[1] -replace '^(\S+).*', '$1'))
foreach ($dep in @('0xef514ed3', '0x7ae476a3')) {
  $sel = @($all | Where-Object { $_ -match $dep })
  Write-Output ("APP {0}: {1} lines" -f $dep, $sel.Count)
  foreach ($l in ($sel | Select-Object -Last 30)) { $t = $l.TrimEnd(); if ($t.Length -gt 230) { $t = $t.Substring(0, 230) + '...' }; Write-Output "  $t" } }
