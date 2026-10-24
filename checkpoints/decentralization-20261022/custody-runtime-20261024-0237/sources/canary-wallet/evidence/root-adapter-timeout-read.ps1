$ErrorActionPreference='Stop'
$h=Invoke-RestMethod http://127.0.0.1:9600/v1/host/state -TimeoutSec 15
$out=@()
foreach($d in @($h.deployments | Where-Object { "$($_.id)$($_.deploymentId)" -match '7ae476a3|ef514ed3' })){
 $o=@{};foreach($n in @('id','deploymentId','status','state','partition','vmId','guestId','port','appId','version')){if($null -ne $d.$n){$o[$n]=$d.$n}}
 $out+=,$o
}
$logs=@();foreach($name in @('node.log','shield.log','network.log')){
 $p=Join-Path $env:ProgramData "Enclave\logs\$name";if(-not(Test-Path $p)){continue}
 $f=[IO.File]::Open($p,'Open','Read','ReadWrite');try{[void]$f.Seek([Math]::Max(0,$f.Length-2MB),'Begin');$text=(New-Object IO.StreamReader($f)).ReadToEnd()}finally{$f.Close()}
 $lines=@($text -split "`n"|Where-Object{$_ -match '7ae476a3|ef514ed3'})
 $categories=@{};foreach($word in @('timeout','refused','denied','closed','egress','certificate','504','503','limit','capacity','claim')){$categories[$word]=@($lines|Where-Object{$_ -match $word}).Count}
 $logs+=@{name=$name;lastWrite=$((Get-Item $p).LastWriteTimeUtc.ToString('o'));matchingLines=$lines.Count;categories=$categories}
}
@{at=(Get-Date).ToUniversalTime().ToString('o');deployments=$out;logs=$logs}|ConvertTo-Json -Depth 6 -Compress
