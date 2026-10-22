#Requires -RunAsAdministrator
# Fill stage @LABEL@'s PUBLIC data (administrator-owned, read-only to the service):
#   windows\fill-data.ps1 artifacts -ToolArgs '--from-dir','D:\retained' [,'--from-origin','http://<replica>:8189' ...]
#   windows\fill-data.ps1 policy [-ToolArgs '--carrier','https://<mirror>/platform-policy']
# (-ToolArgs: an explicit array, so PowerShell never tries to bind the tool's --options as its own parameters)
param([Parameter(Mandatory = $true)][ValidateSet('artifacts', 'policy')][string]$What, [string[]]$ToolArgs = @(), [string]$InstallRoot = '', [string]$TaskName = '')
. (Join-Path $PSScriptRoot 'common.ps1')
Use-StageRoot
if (-not (Test-Path -LiteralPath $Receipt)) { Fail "stage $Label is not installed" }
$node = (Get-Supervisor).node
if ($What -eq 'artifacts') { Invoke-Tool $node (@("$Opt\bin\stage-tool.mjs", 'fill-artifacts', '--manifest', "$Data\bootstrap-manifest.json", '--dir', "$Data\artifacts") + $ToolArgs) }
else { Invoke-Tool $node (@("$Opt\bin\stage-tool.mjs", 'policy-import', '--import-dir', "$Data\policy-import") + $ToolArgs) }
exit $LASTEXITCODE
