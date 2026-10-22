$ErrorActionPreference='Stop'
$p=Join-Path $PSScriptRoot 'check.ps1'
$t=$null;$e=$null
$null=[System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$t,[ref]$e)
if($e.Count) {throw ($e|Out-String)}
$pattern='^C:\\ProgramData\\Enclave\\staging\\txt-merge-check-[0-9a-f]{12}$'
if('C:\ProgramData\Enclave\staging\txt-merge-check-012345abcdef' -notmatch $pattern) {throw 'valid stage rejected'}
foreach($s in @('C:\ProgramData\Enclave\staging','C:\ProgramData\Enclave\staging\txt-merge-check-012345abcdef\..','C:\Program Files\Enclave')) {if($s -match $pattern){throw 'unsafe stage accepted'}}
@{parseErrors=0;stagePatternPositive=$true;stagePatternNegative=$true}|ConvertTo-Json -Compress
