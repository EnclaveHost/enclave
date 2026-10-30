$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
$FP='SHA256:AJ9e7qoY87oouCCs53DIAJVvcfKEgHNikJ83RxSvLsI'
"utc=$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')) host=$env:COMPUTERNAME boot=$((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
$kg=(Get-Command ssh-keygen.exe).Source; "ssh_keygen=$kg"
$pubs=Get-ChildItem -Path 'C:\ProgramData\Enclave','C:\Program Files\Enclave','C:\ProgramData\ssh','C:\Program Files\EnclaveDNS' -Recurse -Depth 6 -File -Force -Filter '*.pub' | Select-Object -First 300
"pub_files_scanned=$(@($pubs).Count)"
foreach($f in $pubs){ $r=& $kg -lf $f.FullName 2>$null; if("$r" -like "*$FP*"){ "pub_match $($f.FullName) sha16=$((Get-FileHash -Algorithm SHA256 $f.FullName).Hash.Substring(0,16).ToLower()) mtime=$($f.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ssZ'))" } }
$hits=Get-ChildItem -Path 'C:\ProgramData\Enclave','C:\Program Files\EnclaveDNS' -Recurse -Depth 5 -File -Force -Include *.json,*.cmd,*.toml,*.yaml,*.yml,*.conf,*.ps1 | Where-Object { $_.Length -lt 2MB -and $_.FullName -notmatch '\\node_modules\\' } | Select-String -Pattern 'enclave-control-tunnel|30443|31053' -List | Select-Object -First 20
foreach($h in $hits){ "mentions $($h.Path) sha16=$((Get-FileHash -Algorithm SHA256 $h.Path).Hash.Substring(0,16).ToLower())" }
$all=Get-CimInstance Win32_Process
$all | ? { $_.CreationDate -and ( ($_.CreationDate.ToUniversalTime() -ge [datetime]'2026-10-23T08:28:00' -and $_.CreationDate.ToUniversalTime() -le [datetime]'2026-10-23T08:32:30') -or ($_.CreationDate.ToUniversalTime() -ge [datetime]'2026-10-23T09:08:30' -and $_.CreationDate.ToUniversalTime() -le [datetime]'2026-10-23T09:10:30') ) } | % { "proc_in_window pid=$($_.ProcessId) name=$($_.Name) exe=$($_.ExecutablePath) started=$($_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))" }
$sw=$all | ? { $_.Name -match 'shielded-worker|vmwp|vmmem|wsl' }; foreach($p in $sw){ "vmish pid=$($p.ProcessId) name=$($p.Name) exe=$($p.ExecutablePath) started=$($p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))" }
try { Get-VM -ErrorAction Stop | % { "hyperv_vm name=$($_.Name) state=$($_.State) uptime=$($_.Uptime)" } } catch { "hyperv_vm query_failed=$($_.Exception.GetType().Name)" }
try { Get-NetNat -ErrorAction Stop | % { "winnat name=$($_.Name) prefix=$($_.InternalIPInterfaceAddressPrefix)" } } catch { "winnat query_failed" }
