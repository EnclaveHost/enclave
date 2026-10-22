param([Parameter(Mandatory)][string]$Scripts)
$ErrorActionPreference='Stop'
$base=Join-Path $env:TEMP ('enclave-stage-fixture-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $base|Out-Null
$commit=('f00d1234'+('a'*32));$target="C:\ProgramData\Enclave\staging\canary-$($commit.Substring(0,8))"
if(Test-Path -LiteralPath $target){throw 'fixture target exists; choose a different unused fixture commit'}
try {
  $bundle=Join-Path $base 'bundle';New-Item -ItemType Directory -Path $bundle|Out-Null
  $files=@('control-source.json','install-host.ps1','guest/runtime.bin','guest/runtime.json','guest/hyperv.psm1','guest/utilities.psm1',
    'bin/shield-host.exe','bin/shield-egress.exe','bin/shielded-bridge.exe','runtime/node/node.exe','runtime/python/python.exe','control/windows/vbslike/manager/main.mjs')
  foreach($rel in $files){$file=Join-Path $bundle ($rel-replace '/','\');New-Item -ItemType Directory -Force (Split-Path -Parent $file)|Out-Null;Set-Content -LiteralPath $file ("fixture "+$rel)}
  [ordered]@{format='enclave-control-source/1';commit=$commit}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $bundle 'control-source.json')
  $keyBlock=Get-Content -LiteralPath (Join-Path $Scripts 'installer-key-block.ps1') -Raw
  Set-Content -LiteralPath (Join-Path $bundle 'install-host.ps1') ($keyBlock+"`n"+'Emit "files" "ok" ("Enclave fixture")')
  $entries=@(foreach($rel in $files){$file=Join-Path $bundle ($rel-replace '/','\');[ordered]@{path=$rel;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()}})
  $manifest=[ordered]@{commit=$commit;controlManifestSha256=('b'*64);files=$entries}
  $mf=Join-Path $bundle 'manifest.json';$runtime=Join-Path $base 'direct-runtime.json';$image=Join-Path $base 'direct.bin'
  Set-Content -LiteralPath $runtime '{}';Set-Content -LiteralPath $image 'test-only direct image'
  function Validate {
    $manifest|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $mf
    & (Join-Path $Scripts 'stage.ps1') -CanaryDir $target -Bundle $bundle -Commit $commit -ManifestSha256 ((Get-FileHash $mf -Algorithm SHA256).Hash.ToLower()) `
      -DirectRuntimeIdentity $runtime -DirectRuntimeSha256 ((Get-FileHash $runtime -Algorithm SHA256).Hash.ToLower()) `
      -DirectImage $image -DirectImageSha256 ((Get-FileHash $image -Algorithm SHA256).Hash.ToLower()) -ValidateOnly
  }
  $ok=Validate;if($ok -notcontains 'VALIDATED: no files or system state changed'){throw 'positive staging validation failed'}
  if(Test-Path -LiteralPath $target){throw 'ValidateOnly wrote staging output'}
  Write-Output 'PASS complete stage provenance validates without writes'
  $manifest.Remove('commit');$rejected=$false;try{Validate|Out-Null}catch{if($_.Exception.Message -notmatch 'exact full source commit'){throw};$rejected=$true}
  if(-not $rejected){throw 'missing commit accepted'};Write-Output 'PASS missing full commit refused'
  $manifest.commit=$commit;$manifest.files=@($entries|Where-Object {$_.path -ne 'runtime/node/node.exe'})
  $rejected=$false;try{Validate|Out-Null}catch{if($_.Exception.Message -notmatch 'required bundle file is absent'){throw};$rejected=$true}
  if(-not $rejected){throw 'missing executable pin accepted'};Write-Output 'PASS missing required executable pin refused'
  $manifest.files=@($entries)+@($entries[0]);$rejected=$false;try{Validate|Out-Null}catch{if($_.Exception.Message -notmatch 'duplicate manifest path'){throw};$rejected=$true}
  if(-not $rejected){throw 'duplicate manifest accepted'};Write-Output 'PASS duplicate manifest paths refused'
  if(Test-Path -LiteralPath $target){throw 'invalid stage wrote output'}
} finally {Remove-Item -LiteralPath $base -Recurse -Force}
Write-Output 'VALIDATION ONLY: no installer, VM, ACL, registry, task or production path was changed'
