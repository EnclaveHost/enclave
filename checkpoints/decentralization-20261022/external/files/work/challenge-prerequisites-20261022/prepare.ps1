# Create only two NEW, inactive directories. Never changes live config, tasks, parent ACLs or running processes.
param([Parameter(Mandatory=$true)][ValidateSet('inspect','apply')][string]$Mode,[string]$Stage='')
$ErrorActionPreference='Stop'
$PF='C:\Program Files\Enclave';$PD='C:\ProgramData\Enclave'
$Target=Join-Path $PF 'challenge-replica';$Declaration=Join-Path $PD 'challenge-replica'
$Config=Join-Path $PD 'host-services\hs2\config\host-services.json';$Network=Join-Path $PD 'network'
$Trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$Files=[ordered]@{
 'dns.mjs'='3e1560f94542f57fb4c93aa6008ec35711fb21439c8adb74c9ee72fc22c90574'
 'network-runtime.bundle.mjs'='3de76b54cf64fc06b5965bcc989290d6653de6e4f6e59f00b0da52e39218d76a'
 'dns.mjs.manifest.json'='aa1ebdb591e15866d30061ae41704c6532ff6ec03a882f920c99058a3bd41bbf'
 'network-profile-base.json'='ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8'
}
function Sha($p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()}
function SafeDirectory($p){
 $i=Get-Item -LiteralPath $p -Force
 if(-not $i.PSIsContainer -or ($i.Attributes -band 1024)){throw "unsafe directory: $p"}
 $a=Get-Acl -LiteralPath $p
 if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $Trusted){throw "untrusted owner: $p"}
 $Bad=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object { $_.AccessControlType -eq 'Allow' -and -not([int]$_.PropagationFlags -band 2) -and ([int]$_.FileSystemRights -band 0x500D0156) -and $_.IdentityReference.Value -notin $Trusted })
 if($Bad.Count){throw "untrusted writers: $p"}
 $a.Sddl
}
foreach($p in 'C:\','C:\Program Files','C:\ProgramData',$PF,$PD){if((Get-Item -LiteralPath $p -Force).Attributes -band 1024){throw 'ancestor reparse point'}}
$Before=@{program=SafeDirectory $PF;data=SafeDirectory $PD;network=(Get-Acl -LiteralPath $Network).Sddl}
if((Test-Path -LiteralPath $Target) -or (Test-Path -LiteralPath $Declaration)){throw 'new target already exists; no overwrite allowed'}
$ConfigSha=Sha $Config
if($ConfigSha -ne 'a02e9ecd8ae1739eed8d324b4db33fe9b6d5643b5d781780949f61a1385c7cfa'){throw 'live hs2 config changed'}
$Privacy=Join-Path $Network 'privacy-config.json';$PrivacySha=Sha $Privacy
$Pc=[IO.File]::ReadAllText($Privacy)|ConvertFrom-Json
if($Pc.enclaveNetwork.PSObject.Properties.Name -contains 'challengeReplica'){throw 'challenge replica already configured'}
if([string](Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2').State -ne 'Running'){throw 'hs2 not running'}
$Result=[ordered]@{at=[DateTime]::UtcNow.ToString('o');mode=$Mode;target=$Target;declaration=$Declaration;configSha=$ConfigSha;privacySha=$PrivacySha;ok=$false;releaseInstalled=$false;declarationCreated=$false}
if($Mode -eq 'inspect'){$Result.ok=$true;$Result|ConvertTo-Json -Compress;exit 0}
if($Stage -notmatch '^C:\\ProgramData\\Enclave\\staging\\challenge-prep-[0-9a-f]{12}$'){throw 'bad stage'}
foreach($name in $Files.Keys){if((Sha (Join-Path $Stage $name)) -ne $Files[$name]){throw "staged pin mismatch: $name"}}
$Run=($Stage -split '-')[-1];$Temp=Join-Path $PF "challenge-replica-prep-$Run";$TempDeclaration=Join-Path $PD "challenge-replica-prep-$Run"
if((Test-Path -LiteralPath $Temp) -or (Test-Path -LiteralPath $TempDeclaration)){throw 'temporary directory collision'}
$TempCreated=$false;$TempDeclarationCreated=$false
try{
 [void][IO.Directory]::CreateDirectory($Temp);$TempCreated=$true
 [void](SafeDirectory $Temp)
 $Release=Join-Path $Temp 'release-3e1560f94542';[void][IO.Directory]::CreateDirectory($Release);[void](SafeDirectory $Release)
 foreach($name in $Files.Keys){$dest=$(if($name -eq 'network-profile-base.json'){$Temp}else{$Release});[IO.File]::Copy((Join-Path $Stage $name),(Join-Path $dest $name),$false);if((Sha (Join-Path $dest $name)) -ne $Files[$name]){throw "copy mismatch: $name"}}
 $Acl=New-Object Security.AccessControl.DirectorySecurity;$Acl.SetAccessRuleProtection($true,$false)
 $Acl.SetOwner((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))
 foreach($row in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@('S-1-5-19','ReadAndExecute'))){$Acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $row[0]),$row[1],'ContainerInherit,ObjectInherit','None','Allow')))}
 [void][IO.Directory]::CreateDirectory($TempDeclaration,$Acl);$TempDeclarationCreated=$true
 [void](SafeDirectory $TempDeclaration)
 # Both complete before either is installed. Move refuses a destination created concurrently; no replacement.
 [IO.Directory]::Move($Temp,$Target);$TempCreated=$false;$Result.releaseInstalled=$true
 [IO.Directory]::Move($TempDeclaration,$Declaration);$TempDeclarationCreated=$false;$Result.declarationCreated=$true
 $Result.files=[ordered]@{}
 foreach($name in $Files.Keys){$dest=$(if($name -eq 'network-profile-base.json'){$Target}else{Join-Path $Target 'release-3e1560f94542'});$Result.files[$name]=Sha (Join-Path $dest $name);if($Result.files[$name] -ne $Files[$name]){throw 'final pin mismatch'}}
 $Result.declarationSddl=(Get-Acl -LiteralPath $Declaration).Sddl
 $Result.parentAclsUnchanged=((Get-Acl -LiteralPath $PF).Sddl -eq $Before.program) -and ((Get-Acl -LiteralPath $PD).Sddl -eq $Before.data) -and ((Get-Acl -LiteralPath $Network).Sddl -eq $Before.network)
 $Result.configsUnchanged=(Sha $Config) -eq $ConfigSha -and (Sha $Privacy) -eq $PrivacySha
 $Result.hs2Running=[string](Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2').State -eq 'Running'
 $Result.ok=$Result.parentAclsUnchanged -and $Result.configsUnchanged -and $Result.hs2Running
}catch{$Result.error=[string]$_.Exception.Message}
finally{
 if($TempCreated){Remove-Item -LiteralPath $Temp -Recurse -Force}
 if($TempDeclarationCreated){Remove-Item -LiteralPath $TempDeclaration -Recurse -Force}
 $Result.temporaryGone=(-not(Test-Path -LiteralPath $Temp)) -and (-not(Test-Path -LiteralPath $TempDeclaration))
 $Result.ok=$Result.ok -and $Result.temporaryGone
}
$Result|ConvertTo-Json -Depth 6 -Compress
if(-not$Result.ok){exit 1}
