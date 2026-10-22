# render.ps1 -- run the REAL launcher/config generation statements of an install-host.ps1 (r5 or r6) with given inputs, LOCAL ONLY.
# The statements are taken from the installer text (from `$appRamGb = ...` through the run-node.cmd RunLoop call), never retyped.
# Only these are substituted (each must match exactly once): the node.exe runtime-id call, the witness check, the GPU-image
# probe (an input instead), the Win32_ComputerSystem owner lookup (an input). Windows path semantics (Join-Path/Split-Path with
# '\') are kept, so the generated text is byte-for-byte what Windows would write; files under $PD are written into -OutDir.
#   pwsh render.ps1 -Installer X.ps1 -Vars vars.json -OutDir DIR     -> DIR/<leaf> files, and DIR/rendered.json {leaf: text}
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Vars, [Parameter(Mandatory)][string]$OutDir)
$ErrorActionPreference = 'Stop'
$V = Get-Content -Raw $Vars | ConvertFrom-Json
New-Item -ItemType Directory -Force $OutDir | Out-Null
$lines = [IO.File]::ReadAllLines($Installer)
$a = [Array]::FindIndex($lines, [Predicate[string]]{ param($l) $l -eq '$appRamGb = [math]::Max(4, [math]::Floor($ramGb / 2))' })
$b = [Array]::FindIndex($lines, [Predicate[string]]{ param($l) $l.StartsWith('RunLoop (Join-Path $PD "run-node.cmd")') })
if ($a -lt 0 -or $b -lt $a) { throw 'render: config section markers not found' }
$text = ($lines[$a..$b] -join "`n")
function Sub([string]$old, [string]$new) {
  $n = ([regex]::Matches($script:text, [regex]::Escape($old))).Count
  if ($n -ne 1) { throw "render: substitution target found $n times: $old" }
  $script:text = $script:text.Replace($old, $new)
}
$rid = ($lines | Where-Object { $_.StartsWith('$runtimeId = & $node ') })
if (@($rid).Count -ne 1) { throw 'render: runtime-id line' }
Sub $rid '$runtimeId = $V.runtimeId'
Sub ($lines | Where-Object { $_.StartsWith('if ($runtimeId -notmatch') }) ''
Sub '$witness = Get-Content -Raw $witnessFile | ConvertFrom-Json' ''
Sub ($lines | Where-Object { $_.StartsWith('if ($witness.derive.runtimeId -ne $runtimeId)') }) ''
Sub 'if (Test-Path $gpuImage) {' 'if ($false) {'
Sub '$(if (Test-Path $gpuProfile) {' '$(if ($V.gpu) {'
Sub 'if (-not $Owner) { $Owner = (Get-CimInstance Win32_ComputerSystem).UserName }' ''

# ---- Windows path semantics and the $PD -> OutDir mapping ----
$PF = [string]$V.PF; $PD = [string]$V.PD
function Join-Path([Parameter(Position = 0)][string]$Path, [Parameter(Position = 1)][string]$ChildPath) { $Path.TrimEnd('\') + '\' + $ChildPath.TrimStart('\') }
function Split-Path([Parameter(Position = 0)][string]$Path) { $Path.Substring(0, $Path.LastIndexOf('\')) }
function MapPD([string]$p) { if ($p.StartsWith($PD + '\', [StringComparison]::OrdinalIgnoreCase)) { [IO.Path]::Combine($OutDir, $p.Substring($PD.Length + 1).Replace('\', '/')) } else { $null } }
function Test-Path([Parameter(Position = 0)]$Path, $LiteralPath, $PathType) { $m = MapPD ([string]$(if ($LiteralPath) { $LiteralPath } else { $Path })); if ($null -eq $m) { return $false }; Microsoft.PowerShell.Management\Test-Path -LiteralPath $m }
function Get-Content([Parameter(Position = 0)]$Path, [switch]$Raw) { $m = MapPD ([string]$Path); if ($Raw) { Microsoft.PowerShell.Management\Get-Content -LiteralPath $m -Raw } else { Microsoft.PowerShell.Management\Get-Content -LiteralPath $m } }
function Select-String($Path, $Pattern) { Microsoft.PowerShell.Utility\Select-String -LiteralPath (MapPD ([string]$Path)) -Pattern $Pattern }
$script:Written = [ordered]@{}
function Set-Content { param([Parameter(Position = 0)][string]$Path, $Encoding, [Parameter(ValueFromPipeline = $true)]$Value)
  begin { $items = [Collections.Generic.List[string]]::new() } process { foreach ($v in @($Value)) { $items.Add([string]$v) } }
  end {
    $leaf = $Path.Substring($Path.LastIndexOf('\') + 1)
    # Set-Content writes each item and a newline; a here-string's own line breaks are normalized to CRLF (as on Windows)
    $body = (($items | ForEach-Object { $_ -replace "`r?`n", "`r`n" }) -join "`r`n") + "`r`n"
    $script:Written[$leaf] = $body
    $m = MapPD $Path; if ($m) { [IO.File]::WriteAllText($m, $body, [Text.Encoding]::ASCII) }
  } }
function Emit($step, $state, $message) { }
function Fail($step, $message) { throw "render: installer Fail($step): $message" }

# ---- the installer's inputs ----
$Name = [string]$V.Name; $Referral = [string]$V.Referral; $independent = [bool]$V.independent; $pinsDest = [string]$V.pinsDest
$want = $V.want; $ramGb = [int]$V.ramGb; $vmgs = [string]$V.vmgs; $vmgsSha = [string]$V.vmgsSha; $Owner = [string]$V.Owner
$node = $PF + '\runtime\node\node.exe'
$manifest = Microsoft.PowerShell.Management\Get-Content -Raw ([string]$V.manifest) | ConvertFrom-Json

Invoke-Expression $text
[IO.File]::WriteAllText([IO.Path]::Combine($OutDir, 'rendered.json'), ($script:Written | ConvertTo-Json -Depth 3))
