$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root='C:\Program Files\Enclave\control\windows\node'
$stage='C:\ProgramData\Enclave\nan-retirement'
$run='C:\ProgramData\Enclave\run-node.cmd'
# Only the node process is restarted. The Shield manager and its guests stay live.
if((Get-FileHash "$root\host.mjs").Hash.ToLower() -ne '84b6a1f474f9b816a98c2f17bee03f88bdc2201a17041fbbbabba910e27ce2d3'){throw 'production host changed since preflight'}
if((Get-FileHash "$root\chain.mjs").Hash.ToLower() -ne 'ed7473fc2f3b343368ceb7909d6068895b5e09efa8f49bfe42f2602b8e48ca94'){throw 'production chain changed since preflight'}
$checks=@{'wallet-host.mjs'='b29f47dbefa65c2a1dd831856a5561865618c6a31e3240b20c19102cef750898';'wallet-chain.mjs'='6bd9df748aeff581b0ce7fe5843d91018b6a6578cfc38ecab3d856116d2373cc';'host-admission.bundle.mjs'='2d4c8bd58e9c184d4c8ed9983ebcf3db5a33e725b6e23986368720f7f77528aa'}
foreach($entry in $checks.GetEnumerator()){if((Get-FileHash "$stage\$($entry.Key)").Hash.ToLower() -ne $entry.Value){throw 'staged file hash mismatch'}}
$before=Invoke-RestMethod 'http://127.0.0.1:8091/vms'
$before.vms|Select-Object id,name,status,appId|ConvertTo-Json -Depth 3|Set-Content "$stage\wallet-runtime-vms-before.json"
if(Test-Path "$stage\run-node.before-wallet.cmd"){throw 'activation backup already exists; inspect previous attempt'}
Copy-Item $run "$stage\run-node.before-wallet.cmd"
$lines=[IO.File]::ReadAllLines($run);$out=@();$inserted=$false
foreach($line in $lines){
 if(-not $inserted -and $line -match 'node.exe.*agent.mjs'){
  $out+='set "ENCLAVE_CONTRACT_PINS_FILE=C:\ProgramData\Enclave\node\contract-pins.json"'
  $out+='set "ENCLAVE_HOST_OWNERSHIP=0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7"'
  $out+='set "ENCLAVE_HOST_REGISTRY_PIN=0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac"'
  $out+='set "ENCLAVE_HOST_CATALOG_PIN=0x18419ca2b502d423a8de6269aeee171a378626e3"'
  $out+='set "ENCLAVE_HOST_POLICY_DIR=C:\ProgramData\Enclave\host-policy"'
  $out+='set "BASE_RPCS=https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org"'
  $inserted=$true
 }
 $out+=$line
}
if(-not $inserted){throw 'node entry point not found'}
Copy-Item "$stage\contract-pins.json" 'C:\ProgramData\Enclave\node\contract-pins.json'
Copy-Item "$stage\host-admission.bundle.mjs" "$root\host-admission.bundle.mjs"
Copy-Item "$stage\wallet-host.mjs" "$root\host.mjs"
Copy-Item "$stage\wallet-chain.mjs" "$root\chain.mjs"
[IO.File]::WriteAllLines($run,$out,[Text.Encoding]::ASCII)
$listener=Get-NetTCPConnection -LocalPort 9600 -State Listen
if(@($listener).Count -ne 1){throw 'unexpected node listener count'}
$oldPid=$listener.OwningProcess
Stop-Process -Id $oldPid -Force
[pscustomobject]@{status='node-restart-requested';oldPid=$oldPid;managerRestarted=$false;hostOwnership='0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7'}|ConvertTo-Json
