param([string]$Native)
$ErrorActionPreference = 'Stop'
Add-Type -Path @((Join-Path $Native 'FixtureJob.cs'),(Join-Path $Native 'FixtureJobCheck.cs'))
$t=$null; $e=$null
[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $Native 'native-bootstrap.ps1'),[ref]$t,[ref]$e)
if ($e.Count) { throw ($e | Out-String) }
'PASS C# compiles and fixture parses (Linux only; no Windows API executed)'
