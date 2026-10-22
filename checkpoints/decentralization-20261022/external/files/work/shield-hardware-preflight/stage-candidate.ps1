$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$expected='c7084346a908465404fdf6de332a76b3c2ca844101eb9e8071aa8a1468f197ec'
$cid='bafybeicfku6twal6ziola575onunood22xqwbkhb5gvmneloxlmko5spoq'
$root=Join-Path $env:ProgramData 'Enclave\staging\shield-direct-c7084346'
[void](New-Item -ItemType Directory -Force -Path $root)
$target=Join-Path $root 'vbs-linux-candidate.bin'
$used=$null
if(Test-Path $target){
 if((Get-FileHash -Algorithm SHA256 $target).Hash.ToLowerInvariant() -ne $expected){throw 'Existing staged candidate hash mismatch; file preserved'}
 $used='existing-verified-file'
}else{
 foreach($origin in @('http://134.199.235.187:8189','http://134.209.248.172:8189')){
  $partial=Join-Path $root ('download-'+[guid]::NewGuid().ToString()+'.partial')
  try{
   Invoke-WebRequest -UseBasicParsing -Uri ($origin+'/ipfs/'+$cid) -OutFile $partial -TimeoutSec 180
   if((Get-Item $partial).Length -ne 77056796){throw 'Candidate size mismatch'}
   if((Get-FileHash -Algorithm SHA256 $partial).Hash.ToLowerInvariant() -ne $expected){throw 'Candidate SHA256 mismatch'}
   Move-Item -Path $partial -Destination $target
   $used=$origin
   break
  }catch{
   if(Test-Path $partial){Remove-Item -LiteralPath $partial}
   if($origin -eq 'http://134.209.248.172:8189'){throw}
  }
 }
}
[pscustomobject]@{ComputerName=$env:COMPUTERNAME;Path=$target;Source=$used;Cid=$cid;Bytes=(Get-Item $target).Length;Sha256=(Get-FileHash -Algorithm SHA256 $target).Hash.ToLowerInvariant();Activated=$false;VMCreated=$false} | ConvertTo-Json
