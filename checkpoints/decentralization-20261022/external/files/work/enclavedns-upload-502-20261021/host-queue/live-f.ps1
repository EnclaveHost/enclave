$ErrorActionPreference='Stop'
# READ-ONLY: every network-circuits sandbox dir (files, mtimes) and its firewall/firewall-config/worker-sandbox JSON with
# secret-looking keys redacted; status.json fields of sia-s3's host circuit and any top-level host-egress fields.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
$sec='(?i)key|secret|token|psk|private|pass|cred|seed|signature|cookie|mnemonic|phrase|user'
$dir=Join-Path $env:ProgramData 'Enclave\network\state\network-circuits'
foreach($d in (Get-ChildItem $dir -Directory | Sort-Object LastWriteTimeUtc)){
  "== $($d.Name) dir-mtime $($d.LastWriteTimeUtc.ToString('MM-dd HH:mm:ss'))"
  foreach($f in (Get-ChildItem $d.FullName -File)){ "  F $($f.Name) $($f.Length) $($f.LastWriteTimeUtc.ToString('MM-dd HH:mm:ss'))"
    if($f.Name -match '^(firewall|firewall-config|worker-sandbox)\.json$'){ $t=[IO.File]::ReadAllText($f.FullName) -replace "(?i)(`"[^`"]*($sec)[^`"]*`"\s*:\s*)(`"[^`"]*`"|\[[^\]]*\])",'$1"<r>"'; if($t.Length -gt 1100){$t=$t.Substring(0,1100)+'...'}; "    $t" } } }
$s=[IO.File]::ReadAllText((Join-Path $env:ProgramData 'Enclave\network\state\status.json'))|ConvertFrom-Json
"== status top keys: $(@($s.PSObject.Properties.Name) -join ',')"
$a=@($s.apps | Where-Object { $_.deploymentId -match 'ef514ed3' })[0]
"== sia-s3 app keys: $(@($a.PSObject.Properties.Name) -join ',')"
foreach($c in $a.circuits){ "  circuit $($c.id.Substring(0,8)) kind=$($c.kind) healthy=$($c.healthy) egress=$($c.egress) ingress=$($c.ingress) keys=$(@($c.PSObject.Properties.Name) -join ',')" }
$h=@($a.circuits | Where-Object { $_.kind -eq 'host' })[0]; if($h){ ($h | ConvertTo-Json -Depth 4 -Compress) -replace "(?i)(`"[^`"]*($sec)[^`"]*`"\s*:\s*)`"[^`"]*`"",'$1"<r>"' }
foreach($n in $s.PSObject.Properties.Name){ if($n -match '(?i)host|egress|firewall|sandbox'){ $v=($s.$n | ConvertTo-Json -Depth 3 -Compress); if($v.Length -gt 600){$v=$v.Substring(0,600)+'...'}; "TOP $n=$v" } }
