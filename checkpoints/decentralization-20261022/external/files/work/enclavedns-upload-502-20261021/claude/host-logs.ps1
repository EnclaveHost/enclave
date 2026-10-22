$ErrorActionPreference='Stop'
# READ-ONLY: host service log lines (network.log, node.log, shield.log) that name the adapter (7ae476a3) or sia-s3 (ef514ed3)
# partitions/deployments, last 64 MiB of each file, timestamps >= 17:55Z. Truncated, redacted. No config/env/key reads.
$ids = 'ef514ed3|7ae476a3|hvd5a51d594439f3|hvab93fbd9cf3c5a'
foreach ($n in @('network.log', 'node.log', 'shield.log')) {
  $p = Join-Path $env:ProgramData "Enclave\logs\$n"
  $fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite'); try {
    $len = $fs.Length; $start = [Math]::Max(0, $len - 64MB); [void]$fs.Seek($start, 'Begin')
    $sr = New-Object IO.StreamReader($fs); $text = $sr.ReadToEnd() } finally { $fs.Close() }
  $lines = $text -split "`n"
  $sel = @($lines | Where-Object { $_ -match $ids -and $_ -match '2026-10-21T(17:5[5-9]|18:)' })
  Write-Output ("FILE {0} size={1} matching={2}" -f $n, $len, $sel.Count)
  foreach ($l in ($sel | Select-Object -Last 45)) {
    $t = $l.TrimEnd()
    $t = $t -replace '(?i)(token|signature|secret|key|authorization|password|credential)\s*[=:]\s*\S+', '$1=<redacted>'
    $t = $t -replace '(?i)(https?|socks5)://[^\s/]*@', '$1://<cred>@'
    if ($t.Length -gt 260) { $t = $t.Substring(0, 260) + '...' }
    Write-Output "  $t" } }
