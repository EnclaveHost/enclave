$ErrorActionPreference='Stop'
# READ-ONLY: the sia-s3 deployment (0xef514ed3)'s own log lines from the local node API (same endpoint as
# work/storage-vm/guest-log-summary.ps1). Only storage/upload-related lines, the last 60, truncated, secrets redacted.
$id='0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238'
$h = Invoke-RestMethod http://127.0.0.1:9600/v1/host/state
$h.deployments | Where-Object { "$($_.id)$($_.deploymentId)" -match '0x(ef514ed3|7ae476a3)' } | Select-Object id,deploymentId,status,engine,runtime | ConvertTo-Json -Compress -Depth 3
try { $r = Invoke-RestMethod "http://127.0.0.1:9600/v1/deployments/$id/logs" } catch { Write-Output "logs unavailable: $($_.Exception.Message)"; Get-VM -Name enclave-storage | Select-Object Name,State,Status,Uptime | ConvertTo-Json -Compress; exit 0 }
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
