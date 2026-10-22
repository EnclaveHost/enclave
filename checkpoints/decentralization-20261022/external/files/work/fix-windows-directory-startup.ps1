$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
$stage='C:\ProgramData\Enclave\nan-retirement'
$run='C:\ProgramData\Enclave\run-node.cmd'
if (!(Test-Path "$stage\run-node.before.cmd")) { Copy-Item $run "$stage\run-node.before.cmd" }
$text=[IO.File]::ReadAllText($run)
$needle='"C:\Program Files\Enclave\runtime\node\node.exe" "C:\Program Files\Enclave\control\windows\node\agent.mjs"'
if (!$text.Contains($needle)) { throw 'Node launch command changed; refusing blind rewrite' }
$rpcs='https://base-rpc.publicnode.com,https://base.gateway.tenderly.co,https://base-public.nodies.app,https://base.drpc.org,https://mainnet.base.org'
$setting='set "BASE_RPCS='+$rpcs+'"'
if (!$text.Contains($setting)) { [IO.File]::WriteAllText($run,$text.Replace($needle,$setting+"`r`n"+$needle),[Text.ASCIIEncoding]::new()) }
Copy-Item "$stage\privacy-agent-bdcc1c8.mjs" 'C:\Program Files\Enclave\network\privacy-agent.mjs' -Force
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'control\\windows\\node\\agent\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$config='C:\ProgramData\Enclave\network\privacy-config.json'
$c=Get-Content $config -Raw | ConvertFrom-Json
$c.chain.rpc=$rpcs.Split(',')
[IO.File]::WriteAllText($config,($c | ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'network\\privacy-agent\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
'Updated directory retry behavior and preserved the five configured RPC origins.'
