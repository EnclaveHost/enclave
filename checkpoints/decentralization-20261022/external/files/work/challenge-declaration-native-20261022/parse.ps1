$ErrorActionPreference='Stop';$t=$null;$e=$null
[void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'fixture.ps1'),[ref]$t,[ref]$e)
if($e.Count){throw ($e|Out-String)}
'parse pass'
