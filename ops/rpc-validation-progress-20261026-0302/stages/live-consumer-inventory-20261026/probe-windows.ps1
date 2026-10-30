$ErrorActionPreference='SilentlyContinue'
"utc=$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')) host=$env:COMPUTERNAME"
function San($u){ try { $x=[uri]$u.Trim(); if($x.IsAbsoluteUri){ return "$($x.Scheme)://$($x.Host):$($x.Port)" } } catch {}; return '<unparsed>' }
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' }
"node_count=$(@($procs).Count)"
$dirs=@{}
foreach($p in $procs){
  $cl=[string]$p.CommandLine
  $m=[regex]::Match($cl,'[A-Za-z]:\\[^"<>|*?]*?\.(mjs|cjs|js)\b')
  $scr=if($m.Success){$m.Value}else{''}
  $h=if($scr -and (Test-Path $scr)){(Get-FileHash -Algorithm SHA256 $scr).Hash.Substring(0,16).ToLower()}else{''}
  $owner=(Invoke-CimMethod -InputObject $p -MethodName GetOwner).User
  "node pid=$($p.ProcessId) ppid=$($p.ParentProcessId) exe=$($p.ExecutablePath) script=$scr sha16=$h user=$owner started=$($p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
  if($scr){ $dirs[(Split-Path $scr)]=1 }
}
Get-ScheduledTask | Where-Object { $_.TaskName -match 'enclave|node|relay|host' -and $_.TaskPath -notmatch '\\Microsoft\\' } | ForEach-Object {
  $a=$_.Actions | Select-Object -First 1
  "task name=$($_.TaskName) state=$($_.State) execute=$($a.Execute) workdir=$($a.WorkingDirectory)"
  if($a.WorkingDirectory){ $dirs[$a.WorkingDirectory]=1 } }
Get-Service | Where-Object { $_.Name -match 'enclave|node|relay' } | ForEach-Object { $c=Get-CimInstance Win32_Service -Filter "Name='$($_.Name)'"; $bin=([regex]::Match([string]$c.PathName,'^"?([^"]+?\.exe)')).Groups[1].Value; "service name=$($_.Name) status=$($_.Status) start=$($_.StartType) bin=$bin" }
$keys='ENCLAVE_CHAIN_AUTHORITY','ENCLAVE_CHAIN_VERIFIER','ENCLAVE_CHAIN_TX_BACKEND','BASE_RPCS'
foreach($d in @($dirs.Keys)){
  $root=$d; for($i=0;$i -lt 3 -and $root;$i++){ if(Test-Path (Join-Path $root 'package.json')){break}; $root=Split-Path $root }
  if($root -and (Test-Path (Join-Path $root 'package.json'))){ $pj=Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json; "pkg root=$root name=$($pj.name) version=$($pj.version)" }
  if($root -and (Test-Path (Join-Path $root '.git\HEAD'))){ "git root=$root head=$((Get-Content (Join-Path $root '.git\HEAD')).Substring(0,[Math]::Min(60,(Get-Content (Join-Path $root '.git\HEAD')).Length)))" }
  foreach($f in Get-ChildItem -Path $root,$d -File -Force | Where-Object { $_.Name -match '\.env$|^\.env|config.*\.json$|node.*\.json$' } | Sort-Object FullName -Unique){
    "configfile path=$($f.FullName) sha16=$((Get-FileHash -Algorithm SHA256 $f.FullName).Hash.Substring(0,16).ToLower())"
    foreach($line in Get-Content $f.FullName){
      foreach($k in $keys){ $mm=[regex]::Match($line,"^\s*`"?$k`"?\s*[=:]\s*`"?([^`"]*)`"?"); if($mm.Success){
        $v=$mm.Groups[1].Value
        if($k -eq 'ENCLAVE_CHAIN_AUTHORITY'){ $out=if($v -match '^(verifier|quorum|)$'){$v}else{'<other>'} } else { $out=(($v -split '[,\s]+' | Where-Object {$_}) | ForEach-Object { San $_ }) -join ',' }
        "  key $k = $out" } } } }
}
foreach($k in 'ENCLAVE_CHAIN_AUTHORITY','ENCLAVE_CHAIN_VERIFIER','BASE_RPCS'){ foreach($s in 'Machine','User'){ $v=[Environment]::GetEnvironmentVariable($k,$s); if($v){ $o=if($k -eq 'ENCLAVE_CHAIN_AUTHORITY'){$v}else{(($v -split '[,\s]+'|?{$_})|%{San $_}) -join ','}; "envscope $s $k = $o" } } }
Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in @($procs.ProcessId) } | ForEach-Object { "node_listen $($_.LocalAddress):$($_.LocalPort) pid=$($_.OwningProcess)" } | Sort-Object -Unique
