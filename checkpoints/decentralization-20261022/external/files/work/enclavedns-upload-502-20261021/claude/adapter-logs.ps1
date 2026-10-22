$ErrorActionPreference='Stop'
# READ-ONLY: the s3-ipfs-adapter deployment's own log lines from the local node API (same endpoint as
# work/storage-vm/guest-log-summary.ps1). Only storage/upload-related lines, the last 60, truncated, secrets redacted.
$id='0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33'
try { $r = Invoke-RestMethod "http://127.0.0.1:9600/v1/deployments/$id/logs" } catch { Write-Output "logs unavailable: $($_.Exception.Message)"; exit 0 }
$lines = @($r.lines)
Write-Output ("total lines: {0}" -f $lines.Count)
$pat = 'pin|s3|put|PUT|multipart|commit|sia|indexd|timeout|timed out|wasm|upload|502|error|failed|refused|reset|deadline'
$sel = @($lines | Where-Object { "$_" -match $pat } | Select-Object -Last 60)
foreach ($l in $sel) {
  $t = "$l"
  $t = $t -replace '(?i)(token|signature|secret|key|authorization|password|x-upload-[a-z]+)\s*[=:]\s*\S+', '$1=<redacted>'
  $t = $t -replace '0x[0-9a-fA-F]{120,}', '<sig>'
  $t = $t -replace '(?i)https?://[^\s/]*@', 'https://<cred>@'
  if ($t.Length -gt 300) { $t = $t.Substring(0, 300) + '...' }
  Write-Output $t }
Get-VM -Name enclave-storage | Select-Object Name,State,Status,Uptime | ConvertTo-Json -Compress
