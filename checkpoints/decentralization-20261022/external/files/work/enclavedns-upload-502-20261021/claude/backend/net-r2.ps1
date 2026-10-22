$ErrorActionPreference='Stop'
# READ-ONLY: network.log lines naming sia-s3 (0xef514ed3), last 64 MiB window. Counts per event template + last 25 lines (truncated).
$p = Join-Path $env:ProgramData 'Enclave\logs\network.log'
$fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite'); try { [void]$fs.Seek([Math]::Max(0, $fs.Length - 64MB), 'Begin'); $text = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
$all = @($text -split "`n")
Write-Output ("now(local) {0}; lines in window: {1}; last line time: {2}" -f (Get-Date -Format o), $all.Count, ($all[-2] -replace '^(\S+).*', '$1'))
$dep = '0xef514ed3'
$sel = @($all | Where-Object { $_ -match $dep })
Write-Output ("APP {0}: {1} lines" -f $dep, $sel.Count)
$t = @{}
foreach ($l in $sel) { $k = ($l -replace '^\S+\s+', '' -replace '\d+', 'N'); if ($k.Length -gt 140) { $k = $k.Substring(0, 140) }; if ($t.ContainsKey($k)) { $t[$k]++ } else { $t[$k] = 1 } }
foreach ($e in ($t.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15)) { Write-Output ("  {0,5} x {1}" -f $e.Value, $e.Key) }
Write-Output "LAST 25:"
foreach ($l in ($sel | Select-Object -Last 25)) { $s = $l.TrimEnd(); if ($s.Length -gt 230) { $s = $s.Substring(0, 230) + '...' }; Write-Output "  $s" }
