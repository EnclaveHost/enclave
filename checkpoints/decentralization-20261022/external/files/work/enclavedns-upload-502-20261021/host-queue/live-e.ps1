$ErrorActionPreference='Stop'
# READ-ONLY: network runtime state files (names/sizes/mtimes), and any JSON state entry naming sia-s3 (0xef514ed3):
# its circuit fields only, secret-looking keys redacted, values truncated.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
$sec='(?i)key|secret|token|psk|private|pass|cred|seed|signature|cookie|mnemonic|phrase|user'
function Show($o,$p,$d){ if($d -gt 4){return}
  if($o -is [Management.Automation.PSCustomObject]){ foreach($n in $o.PSObject.Properties.Name){ if($n -match $sec){ "$p.$n=<redacted>"; continue }; Show $o.$n "$p.$n" ($d+1) } }
  elseif($o -is [Array]){ "$p count=$($o.Count)"; $i=0; foreach($x in ($o|Select-Object -First 6)){ Show $x "$p[$i]" ($d+1); $i++ } }
  else { $s="$o"; if($s.Length -gt 90){$s=$s.Substring(0,90)+'...'}; "$p=$s" } }
Write-Output "NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$dir=Join-Path $env:ProgramData 'Enclave\network\state'
Get-ChildItem $dir -Recurse -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 25 | ForEach-Object { "F {0} {1} {2}" -f $_.FullName.Substring($dir.Length),$_.Length,$_.LastWriteTimeUtc.ToString('HH:mm:ss') }
foreach($f in (Get-ChildItem $dir -Recurse -File -Filter *.json | Where-Object { $_.Length -lt 4MB })){
  $t=[IO.File]::ReadAllText($f.FullName); if($t -notmatch 'ef514ed3'){continue}
  "== $($f.Name)"; try{ $j=$t|ConvertFrom-Json }catch{ "  unparsed"; continue }
  foreach($n in $j.PSObject.Properties.Name){ $v=$j.$n
    if($n -match 'ef514ed3'){ Show $v "$n" 0 | Select-Object -First 60 }
    elseif($v -is [Management.Automation.PSCustomObject]){ foreach($m in $v.PSObject.Properties.Name){ if($m -match 'ef514ed3'){ Show $v.$m "$n.$m" 0 | Select-Object -First 60 } } }
    elseif($v -is [Array]){ $k=0; foreach($x in $v){ if(($x|ConvertTo-Json -Depth 3 -Compress) -match 'ef514ed3'){ Show $x "$n[$k]" 0 | Select-Object -First 60 }; $k++ } } } }
