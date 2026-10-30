$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
"utc=$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')) host=$env:COMPUTERNAME"
function San($u){ try { $x=[uri]$u.Trim(); if($x.IsAbsoluteUri){ return "$($x.Scheme)://$($x.Host):$($x.Port)" } } catch {}; return '<unparsed>' }
$keys='ENCLAVE_CHAIN_AUTHORITY','ENCLAVE_CHAIN_VERIFIER','ENCLAVE_CHAIN_TX_BACKEND','BASE_RPCS','ENCLAVE_CHAIN_RPC','RPC_URL','CHAIN_VERIFIER'
foreach($f in 'C:\ProgramData\Enclave\node-config.cmd','C:\ProgramData\Enclave\lease-relay\relay-config.cmd'){
  if(-not (Test-Path $f)){ "configfile $f missing"; continue }
  $fi=Get-Item $f; "configfile $f sha16=$((Get-FileHash -Algorithm SHA256 $f).Hash.Substring(0,16).ToLower()) mtime=$($fi.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
  $names=@(); foreach($l in Get-Content $f){ $m=[regex]::Match($l,'^\s*set\s+"?([A-Z0-9_]+)='); if($m.Success){ $names+=$m.Groups[1].Value }
    foreach($k in $keys){ $mm=[regex]::Match($l,"^\s*set\s+`"?$k=([^`"]*)`"?"); if($mm.Success){ $v=$mm.Groups[1].Value
      $out=if($k -eq 'ENCLAVE_CHAIN_AUTHORITY'){ if($v -match '^(verifier|quorum|)$'){$v}else{'<other>'} } else { $u=@(($v -split '[,\s]+'|?{$_})|%{San $_}); "n=$($u.Count) " + ($u -join ',') }; "  key $k = $out" } } }
  "  set_var_names_count=$($names.Count) chain_related=$((($names | ? { $_ -match 'RPC|CHAIN|VERIFIER|BACKEND' }) | Sort-Object -Unique) -join ',')" }
$all=Get-CimInstance Win32_Process
foreach($p in $all | ? { $_.Name -eq 'cmd.exe' }){ $cl=[string]$p.CommandLine; $w=if($cl -match 'run-node\.cmd'){'run-node.cmd'}elseif($cl -match 'run-relay\.cmd'){'run-relay.cmd'}else{''}
  if($w){ $k=$all | ? { $_.ParentProcessId -eq $p.ProcessId -and $_.Name -eq 'node.exe' }; "taskcmd pid=$($p.ProcessId) runs=$w node_child=$($k.ProcessId)" } }
"ssh_client_processes=$(@($all | ? { $_.Name -match '^(ssh|autossh|plink)\.exe$' }).Count)"
