$ErrorActionPreference = 'Stop'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /r:System.Web.Extensions.dll "/out:$PSScriptRoot\Check.exe" "$PSScriptRoot\Check.cs"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$PSScriptRoot\Check.exe" $PSScriptRoot
exit $LASTEXITCODE
