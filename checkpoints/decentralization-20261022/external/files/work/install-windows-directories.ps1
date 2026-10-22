$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
$stage='C:\ProgramData\Enclave\nan-retirement'
$agent='C:\Program Files\Enclave\network\privacy-agent.mjs'
$enroll='C:\Program Files\Enclave\control\windows\node\network-enroll.mjs'
$config='C:\ProgramData\Enclave\network\privacy-config.json'
foreach ($pair in @(@($agent,'privacy-agent.before.mjs'),@($enroll,'network-enroll.before.mjs'),@($config,'privacy-config.before.json'))) {
  $backup=Join-Path $stage $pair[1]
  if (!(Test-Path $backup)) { Copy-Item $pair[0] $backup }
}
Copy-Item "$stage\network-enroll-60c6002.mjs" $enroll -Force
Copy-Item "$stage\privacy-agent-2904456.mjs" $agent -Force
# Reload the enrollment module before allowing it to touch the new config.
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'control\\windows\\node\\agent\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$c=Get-Content $config -Raw | ConvertFrom-Json
$c.enclaveNetwork | Add-Member -NotePropertyName directories -NotePropertyValue @('http://134.199.235.187:8188','http://134.209.248.172:8188','http://165.245.191.129:8188','http://146.190.246.39:8188') -Force
$json=$c | ConvertTo-Json -Depth 30
[IO.File]::WriteAllText($config+'.migration-tmp',$json,[Text.UTF8Encoding]::new($false))
Move-Item ($config+'.migration-tmp') $config -Force
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'network\\privacy-agent\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# Existing supervised task wrappers restart the two processes.
Start-ScheduledTask -TaskPath '\Enclave\' -TaskName Node
Start-ScheduledTask -TaskPath '\Enclave\' -TaskName Network
Get-FileHash $agent,$enroll | Select-Object Path,Hash | ConvertTo-Json -Compress
