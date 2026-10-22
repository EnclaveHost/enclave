$ErrorActionPreference='Stop'
# READ-ONLY: the partition console logs of the s3-ipfs-adapter (0x7ae476a3) and sia-s3 (0xef514ed3) apps on minipc.
# Only identifying fields of the manager records; log lines filtered to storage/upload terms, last 50, truncated, redacted.
$v = Invoke-RestMethod http://127.0.0.1:8091/vms
$items = @(if ($v.vms) { $v.vms } elseif ($v -is [array]) { $v } else { $v.PSObject.Properties | ForEach-Object { $_.Value } })
$want = @{}
foreach ($it in $items) {
  $s = ($it | ConvertTo-Json -Compress -Depth 6)
  foreach ($dep in @('7ae476a3', 'ef514ed3')) { if ($s -match "0x$dep") {
    $vid = "$($it.id)"; if (-not $vid) { $vid = "$($it.vmId)" }; if (-not $vid) { $vid = "$($it.name)" }
    $want[$dep] = $vid
    Write-Output ("RECORD {0} vm={1} state={2} status={3}" -f $dep, $vid, "$($it.state)", "$($it.status)") } } }
$dir = Join-Path $env:ProgramData 'Enclave\logs\partitions'
$pat = 'pin|s3|PUT|multipart|commit|sia|indexd|slab|upload|timeout|timed out|wasm|502|503|error|failed|refused|reset|deadline|insufficient|host'
foreach ($dep in $want.Keys) {
  $vid = $want[$dep]
  $files = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*$vid*" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
  if (-not $files.Count) { Write-Output "LOG ${dep} - no console log for ${vid}"; continue }
  $f = $files[0]; Write-Output ("LOG {0} file={1} bytes={2} lastWrite={3:o}" -f $dep, $f.Name, $f.Length, $f.LastWriteTimeUtc)
  $tail = @(Get-Content -LiteralPath $f.FullName -Tail 4000)
  $sel = @($tail | Where-Object { "$_" -match $pat } | Select-Object -Last 50)
  Write-Output ("  tail={0} matching={1}" -f $tail.Count, $sel.Count)
  foreach ($l in $sel) {
    $t = "$l"
    $t = $t -replace '(?i)(token|signature|secret|key|authorization|password|credential|x-upload-[a-z]+|x-amz-[a-z-]+)\s*[=:]\s*\S+', '$1=<redacted>'
    $t = $t -replace '0x[0-9a-fA-F]{120,}', '<sig>'
    $t = $t -replace '(?i)(https?|socks5)://[^\s/]*@', '$1://<cred>@'
    if ($t.Length -gt 300) { $t = $t.Substring(0, 300) + '...' }
    Write-Output "  $t" } }
