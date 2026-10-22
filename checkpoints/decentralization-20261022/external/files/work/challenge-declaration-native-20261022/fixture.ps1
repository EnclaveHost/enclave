param([Parameter(Mandatory=$true)][string]$Stage,[Parameter(Mandatory=$true)][string]$ChainSha)
$ErrorActionPreference='Stop'
if($Stage -notmatch '^C:\\ProgramData\\Enclave\\staging\\decl-check-[0-9a-f]{12}$'){throw 'bad stage'}
function Sha($p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()}
if((Sha "$Stage\chain.txt") -ne $ChainSha){throw 'chain script mismatch'}
$Id=($Stage -split '-')[-1]
$Dir="C:\ProgramData\Enclave\challenge-acl-check-$Id"
$Out="C:\ProgramData\Enclave\host-services\hs2\state\challenge-acl-check-$Id.json"
$Task="challenge-acl-check-$Id";$TaskPath='\Enclave\'
$Parent='C:\ProgramData\Enclave';$Network=Join-Path $Parent 'network'
$BeforeParent=(Get-Acl -LiteralPath $Parent).Sddl;$BeforeNetwork=(Get-Acl -LiteralPath $Network).Sddl
foreach($p in 'C:\','C:\ProgramData',$Parent){if((Get-Item -LiteralPath $p -Force).Attributes -band 1024){throw 'ancestor reparse point'}}
if((Test-Path -LiteralPath $Dir) -or (Test-Path -LiteralPath $Out) -or (Get-ScheduledTask -TaskPath $TaskPath -TaskName $Task -ErrorAction SilentlyContinue)){throw 'fixture collision'}
$Created=$false;$Registered=$false
$Result=[ordered]@{pass=$false;at=[DateTime]::UtcNow.ToString('o');task=$Task;dir=$Dir}
try{
 $Acl=New-Object Security.AccessControl.DirectorySecurity
 $Acl.SetAccessRuleProtection($true,$false)
 $Acl.SetOwner((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))
 foreach($row in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@('S-1-5-19','ReadAndExecute'))){
  $Acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $row[0]),$row[1],'ContainerInherit,ObjectInherit','None','Allow')))
 }
 [void][IO.Directory]::CreateDirectory($Dir,$Acl);$Created=$true
 $Utf8=New-Object Text.UTF8Encoding $false
 [IO.File]::WriteAllText("$Dir\good.json",'{}',$Utf8)
 [IO.File]::WriteAllText("$Dir\unsafe.json",'{}',$Utf8)
 $Bad=Get-Acl -LiteralPath "$Dir\unsafe.json"
 $Bad.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'),'Read','Allow')))
 Set-Acl -LiteralPath "$Dir\unsafe.json" -AclObject $Bad
 $Chain=[IO.File]::ReadAllText("$Stage\chain.txt")
 $Head='$ErrorActionPreference="Stop";$r=[ordered]@{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;chains=[ordered]@{}};'
 $Body=$Head
 foreach($name in 'absent.json','good.json','unsafe.json'){
  $Body+='$env:ENCLAVE_DECL_FILE=' + "'$Dir\$name';" + '$s=@(& {'+$Chain+'});$line=@($s|Where-Object {$_ -like "CHAIN *"})[-1];$r.chains['+"'$name'"+']=($line.Substring(6)|ConvertFrom-Json);'
 }
 $Body+='[IO.File]::WriteAllText('+"'$Out'"+',($r|ConvertTo-Json -Depth 15),(New-Object Text.UTF8Encoding $false));'
 [IO.File]::WriteAllText("$Dir\run.ps1",$Body,$Utf8)
 $Tokens=$null;$Errors=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($Body,[ref]$Tokens,[ref]$Errors)
 if($Errors.Count){throw 'generated task script parse failed'}
 $Action=New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$Dir+'\run.ps1"')
 $Principal=New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
 $Settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 45) -MultipleInstances IgnoreNew
 Register-ScheduledTask -TaskPath $TaskPath -TaskName $Task -Action $Action -Principal $Principal -Settings $Settings | Out-Null;$Registered=$true
 Start-ScheduledTask -TaskPath $TaskPath -TaskName $Task
 $Deadline=[DateTime]::UtcNow.AddSeconds(45)
 do{Start-Sleep -Milliseconds 500;$State=[string](Get-ScheduledTask -TaskPath $TaskPath -TaskName $Task).State}while(($State -eq 'Running' -or $State -eq 'Queued' -or -not(Test-Path -LiteralPath $Out)) -and [DateTime]::UtcNow -lt $Deadline)
 if($State -eq 'Running' -or $State -eq 'Queued'){throw 'task deadline exceeded'}
 $Result.taskResult=[int64](Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $Task).LastTaskResult
 if($Result.taskResult -ne 0 -or -not(Test-Path -LiteralPath $Out)){throw 'task failed or no result'}
 $Result.probe=[IO.File]::ReadAllText($Out)|ConvertFrom-Json
 if($Result.probe.sid -ne 'S-1-5-19'){throw 'wrong executing identity'}
 $Result.pass=$true
}catch{$Result.error=[string]$_.Exception.Message}
finally{
 if($Registered){try{Stop-ScheduledTask -TaskPath $TaskPath -TaskName $Task -ErrorAction SilentlyContinue}catch{};Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $Task -Confirm:$false}
 if($Created){Remove-Item -LiteralPath $Dir -Recurse -Force}
 if(Test-Path -LiteralPath $Out){Remove-Item -LiteralPath $Out -Force}
 $Result.taskGone=-not[bool](Get-ScheduledTask -TaskPath $TaskPath -TaskName $Task -ErrorAction SilentlyContinue)
 $Result.dirGone=-not(Test-Path -LiteralPath $Dir);$Result.outputGone=-not(Test-Path -LiteralPath $Out)
 $Result.parentUnchanged=((Get-Acl -LiteralPath $Parent).Sddl -eq $BeforeParent)
 $Result.networkUnchanged=((Get-Acl -LiteralPath $Network).Sddl -eq $BeforeNetwork)
 $Result.pass=$Result.pass -and $Result.taskGone -and $Result.dirGone -and $Result.outputGone -and $Result.parentUnchanged -and $Result.networkUnchanged
}
$Result|ConvertTo-Json -Compress -Depth 18
if(-not$Result.pass){exit 1}
