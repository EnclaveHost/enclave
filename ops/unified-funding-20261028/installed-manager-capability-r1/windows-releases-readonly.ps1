$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$roots=@('C:\ProgramData\Enclave\native-manager\releases\58ca73a0d002619990c25eedc4d66188533dd76b739afdc2cd8e0efbb4d1a929','C:\ProgramData\Enclave\native-manager\releases\93564093040d89309bbac1b7220e5000aef77f481b68d58a0a4e8ac10748c292')
$out=@();foreach($root in $roots){
 $mf=Join-Path $root 'source-manifest.json';$manifest=Get-Content -Raw -LiteralPath $mf|ConvertFrom-Json;$rows=@()
 foreach($rel in @('windows/vbslike/manager/server.mjs','windows/vbslike/manager/backend.mjs','windows/vbslike/manager/main.mjs','windows/vbslike/router/main.mjs','windows/node/isolation-client.mjs')){
  $f=Join-Path (Join-Path $root 'control') $rel
  if(Test-Path -LiteralPath $f){$h=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant();$lines=@(Select-String -LiteralPath $f -Pattern 'servingPermit|hostAuthorityPermit|leaseExpired|leaseUntil|validUntil|heartbeat|keepalive|deadline|expire|req.method'|ForEach-Object{@{line=$_.LineNumber;text=$_.Line.Trim()}});$rows+=@{path=$rel;sha256=$h;manifestSha256=$manifest.files.$rel.sha256;capabilityLines=$lines}}
 }
 $out+=@{sourceRoot=$root;manifestSha256=(Get-FileHash -LiteralPath $mf -Algorithm SHA256).Hash.ToLowerInvariant();files=$rows}
}
@{checkedAt=[DateTime]::UtcNow.ToString('o');releases=$out}|ConvertTo-Json -Depth 9 -Compress
