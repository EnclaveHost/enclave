$ErrorActionPreference='Stop'
# READ-ONLY: sha256 of every installed module a one-off certificate runner would import; host-state top-level keys and
# the public fields of the sia-s3 record (no env values, keys, CSR or logs).
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(90);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$c=Join-Path $env:ProgramFiles 'Enclave\control'
foreach($f in 'windows\node\hvcert.mjs','windows\node\apptls.mjs','windows\node\isolation-client.mjs','windows\node\chain.mjs','windows\node\host-identity.mjs','windows\node\host-admission.bundle.mjs','windows\node\waf.mjs','windows\node\verification-checkpoints.mjs','windows\node\lease-gas-runtime.bundle.mjs','windows\vbslike\verify\judge-hv.mjs','isolation\m4\guestd\supervisor-guestcert.mjs','isolation\contract\runtime.mjs','network\rpc-identity.mjs'){ $p=Join-Path $c $f; if(Test-Path $p){ "MOD $f $((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower())" } else { "MOD $f absent" } }
"NODEVER $((& (Join-Path $env:ProgramFiles 'Enclave\runtime\node\node.exe') --version) 2>&1)"
$s=Invoke-RestMethod http://127.0.0.1:9600/v1/host/state -TimeoutSec 20
"STATEKEYS $(@($s.PSObject.Properties.Name) -join ',')"
foreach($k in 'endpoint','enclaveId','publicUrl','servingScope','mode'){ if($s.PSObject.Properties.Name -contains $k){ "STATE $k=$($s.$k)" } }
$d=@($s.deployments | Where-Object { $_.id -match '^0xef514ed3' })
"MATCHES $($d.Count)"
foreach($x in $d){ "DEP id=$($x.id) status=$($x.status) isPublic=$($x.isPublic) owner=$($x.owner) version=$($x.version) cid=$($x.cid) gpuShare=$($x.gpuShare) partitionGpuShare=$($x.partitionGpuShare) instance=$($x.isolation.instance) appId=$($x.isolation.appId) tier=$($x.isolation.tier) image=$($x.isolation.image) appRef=$($x.appRef)" }
