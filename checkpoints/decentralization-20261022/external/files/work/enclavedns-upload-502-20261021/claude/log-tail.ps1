$ErrorActionPreference='Stop'
foreach ($n in @('network.log', 'node.log')) {
  $p = Join-Path $env:ProgramData "Enclave\logs\$n"
  $fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite'); try { [void]$fs.Seek([Math]::Max(0, $fs.Length - 200KB), 'Begin'); $text = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
  $lines = @($text -split "`n" | Where-Object { $_.Trim() })
  Write-Output "FILE $n"
  $hits = @($lines | Where-Object { $_ -match 'ef514ed3|7ae476a3|sia-s3|s3-ipfs|adapter' } | Select-Object -Last 12)
  foreach ($l in (@($lines | Select-Object -Last 4) + @('--- naming either app (last 12 in the final 200 KB):') + $hits)) {
    $t = "$l".TrimEnd() -replace '(?i)(token|signature|secret|key|authorization|password|credential)\s*[=:]\s*\S+', '$1=<redacted>'
    if ($t.Length -gt 240) { $t = $t.Substring(0, 240) + '...' }
    Write-Output "  $t" } }
