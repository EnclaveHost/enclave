# R-reads.ps1 - ROOT-RUN, READ-ONLY (Windows PowerShell 5.1, elevated). Every input PLAN.txt lists as "required root read".
# Output: ONE JSON line of shas, SIDs, rights, flags, file NAMES (digests) and key NAMES. Never a config value, key or log line.
$ErrorActionPreference = 'Stop'
$S = [Security.Principal.SecurityIdentifier]
function Sha($p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function AclOf($p) {
  if (-not (Test-Path -LiteralPath $p)) { return [ordered]@{ path = $p; exists = $false } }
  $a = Get-Acl -LiteralPath $p; $i = Get-Item -LiteralPath $p -Force
  [ordered]@{ path = $p; exists = $true; owner = $a.GetOwner($S).Value; protected = $a.AreAccessRulesProtected; reparse = [bool]($i.Attributes -band 1024)
    aces = @($a.GetAccessRules($true, $true, $S) | ForEach-Object { '{0} {1} 0x{2:X8} inh={3} prop={4} inherited={5}' -f $_.AccessControlType, $_.IdentityReference.Value, [int]$_.FileSystemRights, [int]$_.InheritanceFlags, [int]$_.PropagationFlags, $_.IsInherited })
    # does LOCAL SERVICE get READ_CONTROL here, directly or via Users / Authenticated Users / Everyone (non-inherit-only allow)?
    lsReadControl = [bool](@($a.GetAccessRules($true, $true, $S) | Where-Object { $_.AccessControlType -eq 'Allow' -and -not ([int]$_.PropagationFlags -band 2) -and
      ([int]$_.FileSystemRights -band 0x10020000) -and $_.IdentityReference.Value -in @('S-1-5-19', 'S-1-5-32-545', 'S-1-5-11', 'S-1-1-0') }).Count) } }
$PD = 'C:\ProgramData\Enclave'; $PF = 'C:\Program Files\Enclave'
$o = [ordered]@{ at = [DateTime]::UtcNow.ToString('o') }
# R3 the declaration path chain (+ the declaration dir must not exist yet)
$o.chain = @('C:\', 'C:\ProgramData', $PD, "$PD\network", "$PD\network\challenge") | ForEach-Object { AclOf $_ }
# R6 the release/profile delivery target (must not exist) and its parent's ACL
$o.deliveryParent = AclOf "$PF\network"; $o.deliveryTarget = (Test-Path -LiteralPath "$PF\network\challenge-replica")
# R5 the live Shield app policy the replica will pin by path
$f = "$PF\network\admitted-shield-policy.json"; $o.shieldPolicy = [ordered]@{ sha = (Sha $f); schema = $(try { [string]([IO.File]::ReadAllText($f) | ConvertFrom-Json).schema } catch { $null }) }
# R4 ports the block and G4 use (TCP listen + UDP bind), and the tunnel listener (upstream dependency, R10)
$o.ports = [ordered]@{}; foreach ($p in 18353, 18354, 18291, 18292, 31053) {
  $o.ports["$p"] = [ordered]@{ tcp = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress }); udp = @(Get-NetUDPEndpoint -LocalPort $p -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress }) } }
# R2 the policy carrier stores: file NAMES (= digests) only
$o.policyStore = [ordered]@{
  mirrorDocuments = @(Get-ChildItem -LiteralPath "$PD\host-services\hs2\state\policy-mirror-state\documents" -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  importDir = @(Get-ChildItem -LiteralPath "$PD\host-services\hs2\data\policy-import" -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) }
# R7/R8 the network side the edit depends on: enroll + privacy-agent bytes, privacy-config sha + enclaveNetwork key NAMES
$o.enroll = Sha "$PF\control\windows\node\network-enroll.mjs"; $o.privacyAgent = Sha "$PF\network\privacy-agent.mjs"
$cf = "$PD\network\privacy-config.json"; $o.privacyConfig = [ordered]@{ sha = (Sha $cf); enKeys = @(([IO.File]::ReadAllText($cf) | ConvertFrom-Json).enclaveNetwork.PSObject.Properties.Name) }
$o.hostPolicyStateDir = (Test-Path -LiteralPath "$PD\network\state\challenge-host-policy")
# (review 9d) R12 the file's ending (enroll writes none, the hold cutover "\n"): the edit keeps whichever it finds
$o.privacyConfig.finalNewline = ([IO.File]::ReadAllBytes($cf)[-1] -eq 10)
# (review 9d) R13 how many objects M1's Set-Acl on the network dir walks (inheritance re-propagation), and how many are protected
$t = @(Get-ChildItem -LiteralPath "$PD\network" -Recurse -Force -ErrorAction SilentlyContinue)
$o.networkTree = [ordered]@{ objects = $t.Count; protectedSample = @($t | Select-Object -First 400 | Where-Object { (Get-Acl -LiteralPath $_.FullName).AreAccessRulesProtected }).Count }
$o | ConvertTo-Json -Compress -Depth 6
