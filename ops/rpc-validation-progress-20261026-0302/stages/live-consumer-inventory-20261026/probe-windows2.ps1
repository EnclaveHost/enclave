$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
"utc=$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')) host=$env:COMPUTERNAME"
function San($u){ try { $x=[uri]$u.Trim(); if($x.IsAbsoluteUri){ return "$($x.Scheme)://$($x.Host):$($x.Port)" } } catch {}; return '<unparsed>' }
$all = Get-CimInstance Win32_Process
foreach($p in $all | Where-Object { $_.Name -match '^(ssh|autossh|plink)\.exe$' }){
  $cl=[string]$p.CommandLine
  $fw=([regex]::Matches($cl,'-R\s*"?((127\.0\.0\.1:)?(30443|30080|31053):[A-Za-z0-9\.\-]+:\d+)') | ForEach-Object { $_.Groups[1].Value }) -join ','
  $dst=([regex]::Matches($cl,'\b(eu-central|us-west|ca-east|ap-southeast|enclave-control-tunnel@[A-Za-z0-9\.\-]+)\b') | ForEach-Object { $_.Value } | Sort-Object -Unique) -join ','
  $par=$all | Where-Object { $_.ProcessId -eq $p.ParentProcessId }
  "ssh pid=$($p.ProcessId) exe=$($p.ExecutablePath) parent=$($par.Name)/$($p.ParentProcessId) forwards=$fw dest=$dst started=$($p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
}
foreach($tn in 'Node','Relay'){ $t=Get-ScheduledTask -TaskName $tn; $i=Get-ScheduledTaskInfo -TaskName $tn
  $arg=[string]$t.Actions[0].Arguments; $tgt=([regex]::Matches($arg,'[A-Za-z]:\\[^"<>|*?&]*?\.(cmd|bat|ps1|mjs|exe)\b') | ForEach-Object { $_.Value }) -join ','
  "task $tn path=$($t.TaskPath) state=$($t.State) user=$($t.Principal.UserId) lastrun=$($i.LastRunTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')) target_files=$tgt"
  foreach($f in ($tgt -split ',' | Where-Object { $_ -and (Test-Path $_) })){ "  file $f sha16=$((Get-FileHash -Algorithm SHA256 $f).Hash.Substring(0,16).ToLower())"
    foreach($l in Get-Content $f){ $m=[regex]::Match($l,'[A-Za-z]:\\[^"<>|*?&]*?\.(mjs|exe|cmd|ps1|env|json)\b'); if($m.Success){ "    references $($m.Value)" } } } }
foreach($p in $all | Where-Object { $_.Name -eq 'cmd.exe' }){ $kids=$all | Where-Object { $_.ParentProcessId -eq $p.ProcessId }; if($kids){ "cmd pid=$($p.ProcessId) children=$((($kids | ForEach-Object { "$($_.Name)/$($_.ProcessId)" }) -join ','))" } }
$keys='ENCLAVE_CHAIN_AUTHORITY','ENCLAVE_CHAIN_VERIFIER','ENCLAVE_CHAIN_TX_BACKEND','BASE_RPCS'
foreach($f in Get-ChildItem -Path 'C:\ProgramData\Enclave','C:\Program Files\Enclave\control\windows' -Recurse -Depth 3 -File -Force | Where-Object { $_.Name -match '(^|\.)env$|^\.env|^(node|agent|config|relay|settings)[^\\]*\.json$' -and $_.FullName -notmatch '\\node_modules\\|\\releases\\.*\\node_modules' } | Select-Object -First 40){
  $hits=@(); foreach($line in Get-Content $f.FullName){ foreach($k in $keys){ $mm=[regex]::Match($line,"^\s*`"?$k`"?\s*[=:]\s*`"?([^`"]*)`"?"); if($mm.Success){ $v=$mm.Groups[1].Value
    $out=if($k -eq 'ENCLAVE_CHAIN_AUTHORITY'){ if($v -match '^(verifier|quorum|)$'){$v}else{'<other>'} } else { (($v -split '[,\s]+'|?{$_})|%{San $_}) -join ',' }; $hits+="  key $k = $out" } } }
  if($hits){ "configfile $($f.FullName) sha16=$((Get-FileHash -Algorithm SHA256 $f.FullName).Hash.Substring(0,16).ToLower()) mtime=$($f.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ssZ'))"; $hits } }
foreach($d in 'C:\Program Files\Enclave\control\windows\node','C:\Program Files\Enclave\control'){ foreach($n in 'VERSION','RELEASE','release.json','.source-commit','MANIFEST.json'){ $q=Join-Path $d $n; if(Test-Path $q){ "version_file $q sha16=$((Get-FileHash -Algorithm SHA256 $q).Hash.Substring(0,16).ToLower()) first=$(((Get-Content $q -TotalCount 1) -replace '[^\w\.\-: ]','').Substring(0,[Math]::Min(60,((Get-Content $q -TotalCount 1)).Length)))" } } }
foreach($q in 'C:\Program Files\Enclave\control\windows\node\chain.mjs'){ if(Test-Path $q){ $c=Get-Content $q -Raw; "chain_mjs sha16=$((Get-FileHash -Algorithm SHA256 $q).Hash.Substring(0,16).ToLower()) mentions_ENCLAVE_CHAIN_AUTHORITY=$($c -match 'ENCLAVE_CHAIN_AUTHORITY') mentions_BASE_RPCS=$($c -match 'BASE_RPCS')" } }
