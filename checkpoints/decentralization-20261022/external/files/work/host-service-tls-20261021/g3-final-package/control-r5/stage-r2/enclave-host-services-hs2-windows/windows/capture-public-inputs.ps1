# PUBLIC-ONLY capture on the Windows host (reads no env file, private configuration, database or key). Writes:
#   listeners.txt   this host's listening TCP/UDP sockets as ss-style lines (gen-config refuses a port in use)
# and prints node's path/version, one agreed block of public Base state for this host's registry endpoint, and a dry-run
# policy import. Run from the extracted stage:  windows\capture-public-inputs.ps1 -NodeExe <node.exe> [-Endpoint <url>]
param([Parameter(Mandatory = $true)][string]$NodeExe, [string]$Endpoint = 'https://api.enclave.host/t/nucbox-k11-4', [string]$Out = '.\listeners.txt')
. (Join-Path $PSScriptRoot 'common.ps1')
Use-StageRoot
$v = Invoke-Tool $NodeExe @('-p', 'process.version'); Write-Output "== node: $NodeExe $v"
$lines = @()
foreach ($t in Get-NetTCPConnection -State Listen) { $a = $t.LocalAddress; if ($a -match ':') { $a = "[$a]" }; $lines += "tcp LISTEN 0 0 ${a}:$($t.LocalPort) *:*" }
foreach ($u in Get-NetUDPEndpoint) { $a = $u.LocalAddress; if ($a -match ':') { $a = "[$a]" }; $lines += "udp UNCONN 0 0 ${a}:$($u.LocalPort) *:*" }
$lines | Set-Content -LiteralPath $Out -Encoding ASCII
Write-Output "== $($lines.Count) listeners written to $Out"
$spec = Get-Content -Raw -LiteralPath (Join-Path $Stage 'config\spec.windows.json') | ConvertFrom-Json
$pin = [IO.Path]::GetTempFileName(); [IO.File]::WriteAllText($pin, ($spec.serviceIndex | ConvertTo-Json -Compress))
Write-Output '== public chain facts'
Invoke-Tool $NodeExe @((Join-Path $Stage 'bin\stage-tool.mjs'), 'capture-public', '--endpoint', $Endpoint, '--index-pin', $pin)
Write-Output '== anchored policy (dry run)'
Invoke-Tool $NodeExe @((Join-Path $Stage 'bin\stage-tool.mjs'), 'policy-import', '--import-dir', 'C:\nonexistent-dry-run', '--dry-run')
Remove-Item -LiteralPath $pin
