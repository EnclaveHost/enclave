$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
"utc=$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')) host=$env:COMPUTERNAME"
$fronts=@{'134.209.248.172'='eu-central';'134.199.235.187'='us-west';'146.190.246.39'='ca-east';'165.245.191.129'='ap-southeast'}
$all=Get-CimInstance Win32_Process
$c=Get-NetTCPConnection -State Established | Where-Object { $fronts.ContainsKey($_.RemoteAddress) }
"est_to_fronts_count=$(@($c).Count)"
foreach($x in $c){ $p=$all | ? { $_.ProcessId -eq $x.OwningProcess }; $pp=$all | ? { $_.ProcessId -eq $p.ParentProcessId }
  $m=[regex]::Match([string]$p.CommandLine,'[A-Za-z]:\\[^"<>|*?&]*?\.(mjs|cjs|js)\b'); $h=if($m.Success -and (Test-Path $m.Value)){(Get-FileHash -Algorithm SHA256 $m.Value).Hash.Substring(0,16).ToLower()}else{''}
  $svc=(Get-CimInstance Win32_Service | ? { $_.ProcessId -eq $p.ProcessId } | % Name) -join ','
  "est local=$($x.LocalAddress):$($x.LocalPort) remote=$($x.RemoteAddress):$($x.RemotePort)($($fronts[$x.RemoteAddress])) pid=$($p.ProcessId) name=$($p.Name) exe=$($p.ExecutablePath) script=$($m.Value) sha16=$h service=$svc parent=$($pp.Name)/$($p.ParentProcessId) pexe=$($pp.ExecutablePath) started=$($p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))" }
foreach($f in 'C:\ProgramData\ssh\ssh_config',"$env:USERPROFILE\.ssh\config",'C:\Windows\System32\config\systemprofile\.ssh\config'){ if(Test-Path $f){ "sshcfg $f sha16=$((Get-FileHash -Algorithm SHA256 $f).Hash.Substring(0,16).ToLower())"; Get-Content $f | % { if($_ -match '^\s*(Host|RemoteForward)\s+(.*)$'){ "  $($Matches[1]) $($Matches[2].Trim())" } } } else { "sshcfg $f absent_or_unreadable" } }
Get-NetTCPConnection -State Listen | ? { $_.LocalPort -in 30443,30080,31053,443,80,8443 } | % { $p=$all | ? { $_.ProcessId -eq $_.OwningProcess }; "listen $($_.LocalAddress):$($_.LocalPort) pid=$($_.OwningProcess) name=$((Get-Process -Id $_.OwningProcess).ProcessName)" }
