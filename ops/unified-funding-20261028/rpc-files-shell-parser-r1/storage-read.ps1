$ErrorActionPreference='Stop'
$results=@(
$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseInput('"C:\EnclaveRpcClock-856c8213f2a149c3a24e27904e2093c6\856c8213f2a149c3a24e27904e2093c6\clock-sample.exe" 4368a8d4ff074ee099c2ec0599e1c25b 773b4c8e341d44d89e6a44a7934a6f05 57c35df39b752694a9cd420b84eed6c1f800c0331c2442dbe8fb743eacaf03f6',[ref]$tokens,[ref]$errors);@{form='quoted';errorCount=@($errors).Count;errorIds=@($errors|ForEach-Object {$_.ErrorId});executed=$false}
$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseInput('C:\EnclaveRpcClock-856c8213f2a149c3a24e27904e2093c6\856c8213f2a149c3a24e27904e2093c6\clock-sample.exe 4368a8d4ff074ee099c2ec0599e1c25b 773b4c8e341d44d89e6a44a7934a6f05 57c35df39b752694a9cd420b84eed6c1f800c0331c2442dbe8fb743eacaf03f6',[ref]$tokens,[ref]$errors);@{form='plain';errorCount=@($errors).Count;errorIds=@($errors|ForEach-Object {$_.ErrorId});executed=$false}
)
[pscustomobject]@{success=$true;results=$results;readOnly=$true;atUtc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Depth 5 -Compress
