# hvnode-reboot-reads.ps1 - READ-ONLY: three reads after the host reboot that the capture script does not make
# (REBOOT-GO-v42.md step 7a; enclave-87 after enclave-5d's DONE audit). Reads only; writes nothing but reads-post.json in
# -OutDir (-OutDir - prints it). Never reads the hosting token.
#   powershell -ExecutionPolicy Bypass -File hvnode-reboot-reads.ps1 -DeploymentId 0x<64> -OutDir <the reboot OutDir>
# 1. the manager's record for the deployment: exactly one, running, on the expected guest image (v42: 0891c740...);
# 2. the node tree: run-node.cmd has the expected sha256 and runs <Root>\<tree>\windows\node\agent.mjs, and exactly one
#    running node.exe is that agent.mjs;
# 3. the hosting admin port (the tray's backend, :9610): a loopback-only listener OWNED by that agent's pid, answering an
#    unauthenticated GET with the hosting handler's own 401.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^0x[0-9a-fA-F]{64}$')][string]$DeploymentId,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectImage = '0891c740ddf18ded1ea903495b70c799a5cfbe498d05843e47c7b84106ed7998',
  [ValidatePattern('^[0-9a-f]{8,40}$')][string]$ExpectTree = 'f1461271',
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectRunNodeSha256 = '5f1a79b4c192743360344c640291457249b25c51f6bdafde1e12d9c0888a4507',
  [string]$Root = 'C:\Users\claude\vbs-like\hvnode',
  [int]$ManagerPort = 8091,
  [int]$HostingPort = 9610
)
$ErrorActionPreference = 'Stop'
$script:fails = 0
function Say([string]$k, [string]$m) { Write-Output ("{0,-4} {1}" -f $k, $m); if ($k -eq 'FAIL') { $script:fails++ } }
function Check([bool]$ok, [string]$m) { if ($ok) { Say 'PASS' $m } else { Say 'FAIL' $m } }
$id = $DeploymentId.ToLower()
$out = @{ at = (Get-Date).ToUniversalTime().ToString('o'); deploymentId = $id }
$out.bootId = $(try { [int](Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters' -Name BootId -ErrorAction Stop).BootId } catch { $null })

# 1. the record
$recs = @(@((Invoke-RestMethod -Uri "http://127.0.0.1:$ManagerPort/vms" -TimeoutSec 10 -UseBasicParsing).vms) | Where-Object { "$($_.name)".ToLower() -eq $id })
$out.records = @($recs | ForEach-Object { @{ id = [string]$_.id; status = [string]$_.status; image = [string]$_.image; key = [string]$_.transportKeySha256 } })
Check ($recs.Count -eq 1) "the manager holds ONE record for $($id.Substring(0,10)) ($($recs.Count))"
if ($recs.Count -eq 1) {
  Check ("$($recs[0].status)" -eq 'running') "its status: $($recs[0].status)"
  Check ("$($recs[0].image)".ToLower() -eq $ExpectImage) "its image: $($recs[0].image) (expected $ExpectImage)"
}

# 2. the node tree
$rn = Join-Path $Root 'run-node.cmd'
$agent = Join-Path $Root "$ExpectTree\windows\node\agent.mjs"
$rnSha = if (Test-Path -LiteralPath $rn) { (Get-FileHash -LiteralPath $rn -Algorithm SHA256).Hash.ToLower() } else { $null }
$out.runNodeSha256 = $rnSha
Check ($rnSha -eq $ExpectRunNodeSha256) "run-node.cmd sha256 $rnSha (expected $ExpectRunNodeSha256)"
Check ([bool](Select-String -LiteralPath $rn -SimpleMatch -Pattern ('"' + $agent + '"') -Quiet)) "run-node.cmd runs $agent"
$nodes = @(@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'") | Where-Object { "$($_.CommandLine)" -like "*`"$agent`"*" })
$out.agentPids = @($nodes | ForEach-Object { [int]$_.ProcessId })
Check ($nodes.Count -eq 1) "exactly one running node.exe is $agent (pids $($out.agentPids -join ','))"

# 3. the hosting admin port
$ls = @(Get-NetTCPConnection -LocalPort $HostingPort -State Listen -ErrorAction SilentlyContinue)
$out.hostingListeners = @($ls | ForEach-Object { @{ address = [string]$_.LocalAddress; pid = [int]$_.OwningProcess } })
Check ($ls.Count -ge 1 -and @($ls | Where-Object { "$($_.LocalAddress)" -ne '127.0.0.1' }).Count -eq 0) ":$HostingPort listens on 127.0.0.1 only ($(@($ls | ForEach-Object { "$($_.LocalAddress)" }) -join ','))"
if ($nodes.Count -eq 1) { Check (@($ls | Where-Object { [int]$_.OwningProcess -eq [int]$nodes[0].ProcessId }).Count -ge 1) ":$HostingPort is owned by the $ExpectTree agent (pid $($nodes[0].ProcessId))" }
$code = $null; $body = ''
try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$HostingPort/v1/local/hosting" -TimeoutSec 10 -UseBasicParsing; $code = [int]$r.StatusCode; $body = [string]$r.Content }
catch { $resp = $_.Exception.Response; if ($resp) { $code = [int]$resp.StatusCode; $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } }
$out.hostingUnauthenticated = @{ status = $code; body = $body }
Check ($code -eq 401 -and $body -match 'hosting-admin\.token') ":$HostingPort answers an unauthenticated GET with the hosting handler's 401: $code $body"

$json = $out | ConvertTo-Json -Depth 5
if ($OutDir -eq '-') { $json } else { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null; Set-Content -Path (Join-Path $OutDir 'reads-post.json') -Value $json -Encoding UTF8 }
if ($script:fails) { Write-Output "READS: $($script:fails) FAIL"; exit 1 } else { Write-Output 'READS: no FAIL'; exit 0 }
