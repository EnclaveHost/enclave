$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$rows=@()
foreach($port in @(8095,8097)) {
 $c=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
 if(-not $c){continue}
 $pr=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c.OwningProcess)
 $modules=@()
 $foundPaths=[regex]::Matches($pr.CommandLine,'(?:"([^"\r\n]+\.mjs)"|([^\s"]+\.mjs))')
 foreach($item in $foundPaths) {
  $f=if($item.Groups[1].Success){$item.Groups[1].Value}else{$item.Groups[2].Value}
  if(-not(Test-Path -LiteralPath $f)){continue}
  $modules+=@{path=$f;sha256=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant()}
  foreach($name in @('server.mjs','backend.mjs','main.mjs','desktop-router.mjs')) {
   $q=Join-Path (Split-Path $f) $name
   if(Test-Path -LiteralPath $q) {
    $lines=@(Select-String -LiteralPath $q -Pattern 'servingPermit|hostAuthorityPermit|leaseExpired|leaseUntil|validUntil|heartbeat|keepalive|deadline|expire' | ForEach-Object { @{line=$_.LineNumber;text=$_.Line.Trim()} })
    $modules+=@{path=$q;sha256=(Get-FileHash -LiteralPath $q -Algorithm SHA256).Hash.ToLowerInvariant();deadlineLines=$lines}
   }
  }
 }
 $rows+=@{port=$port;pid=$c.OwningProcess;executable=$pr.ExecutablePath;modules=$modules}
}
@{checkedAt=[DateTime]::UtcNow.ToString('o');listeners=$rows}|ConvertTo-Json -Depth 8 -Compress
