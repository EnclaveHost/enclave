$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
"utc=$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')) host=$env:COMPUTERNAME"
try { $v=Get-VM -Name enclave-control -ErrorAction Stop; "vm name=$($v.Name) state=$($v.State) uptime=$($v.Uptime) started_utc=$(([DateTime]::UtcNow - $v.Uptime).ToString('yyyy-MM-ddTHH:mm:ssZ')) ips=$(((Get-VMNetworkAdapter -VMName enclave-control).IPAddresses | ? { $_ -match '^\d+\.' }) -join ',')" } catch { "vm query_failed=$($_.Exception.Message.Substring(0,[Math]::Min(80,$_.Exception.Message.Length)))" }
