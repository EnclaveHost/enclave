# isolated-probe.lib.ps1 -- the decisions isolated-probe.ps1 makes, as pure functions over values it is
# given rather than over the live machine. Split out for one reason: every one of these is a failure path
# that must be exercised without a host to fail on, which isolated-probe.tests.ps1 does with mocked
# inputs. Nothing in this file reads the registry, the filesystem or a process.

Set-StrictMode -Version Latest

# Property access that answers "absent" instead of throwing. Under Set-StrictMode -Version Latest a
# missing property is a terminating error, so reading untrusted JSON needs this: the whole point of
# Read-ProbeResult is to decide that a field is missing, not to die when it is.
function Get-Prop {
  param([object] $Object, [string] $Name)
  if ($null -eq $Object) { return $null }
  if ($Object -is [hashtable]) { if ($Object.ContainsKey($Name)) { return $Object[$Name] } else { return $null } }
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

# Whether the property EXISTS, separately from what it holds. PowerShell unrolls a collection returned
# from a function, so a property holding an empty array comes back from Get-Prop as $null and is
# indistinguishable from a missing one -- which is how an empty, perfectly good enumeration read as "no
# result array" until this existed. Presence is a boolean and survives the return.
function Test-PropPresent {
  param([object] $Object, [string] $Name)
  if ($null -eq $Object) { return $false }
  if ($Object -is [hashtable]) { return $Object.ContainsKey($Name) }
  return $null -ne $Object.PSObject.Properties[$Name]
}

# --- the setting's state -----------------------------------------------------------------------------
# Absent, Present and Error are three different answers and the third must never be reported as the
# first: an unreadable value would otherwise be "restored" to absent, i.e. deleted, by a script whose
# purpose is to leave the host as it found it. The caller passes the raw results of its two reads.
#   $keyExists   : did the key itself open
#   $valueRead   : @{ Ok = $bool; Value = <object>; Kind = <string>; Error = <string> } from ONE attempt
function Resolve-SettingState {
  param([bool] $KeyExists, [hashtable] $ValueRead)
  if (-not $KeyExists) { return [pscustomobject]@{ Status = 'Error'; Value = $null; Kind = $null; Error = 'the Virtualization key could not be opened' } }
  if ($null -eq $ValueRead) { return [pscustomobject]@{ Status = 'Error'; Value = $null; Kind = $null; Error = 'no read was attempted' } }
  if ($ValueRead.Ok) { return [pscustomobject]@{ Status = 'Present'; Value = $ValueRead.Value; Kind = $ValueRead.Kind; Error = $null } }
  # a read that failed for any reason OTHER than the value not existing is an error, not an absence
  if ($ValueRead.Error -match 'does not exist|cannot find|not found|ObjectNotFound|PropertyNotFound') {
    return [pscustomobject]@{ Status = 'Absent'; Value = $null; Kind = $null; Error = $null }
  }
  return [pscustomobject]@{ Status = 'Error'; Value = $null; Kind = $null; Error = $ValueRead.Error }
}

# Restoration is only restoration when the STATUS, the VALUE and the registry TYPE all match what was
# there before. A value restored as the wrong kind is a changed host.
function Test-SettingRestored {
  param([pscustomobject] $Before, [pscustomobject] $Now)
  if ($null -eq $Before -or $null -eq $Now) { return $false }
  if ($Before.Status -ne $Now.Status) { return $false }
  if ($Before.Status -ne 'Present') { return $Before.Status -eq 'Absent' }   # Error is never "restored"
  return ($Before.Value -eq $Now.Value) -and ($Before.Kind -eq $Now.Kind)
}

# --- the image's access ------------------------------------------------------------------------------
# The question is not "is there an ACE for the VM worker" but "can it READ, and is nothing denying it".
# A Deny ACE anywhere for that identity, or an Allow that grants something other than read, must not pass.
# $Aces: @( @{ Identity = 'NT VIRTUAL MACHINE\Virtual Machines'; Type = 'Allow'|'Deny'; Rights = 'Read, Synchronize' } )
function Test-ImageReadAccess {
  param([object[]] $Aces, [string] $Identity = 'NT VIRTUAL MACHINE\Virtual Machines', [string] $Sid = 'S-1-5-83-0')
  $mine = @($Aces | Where-Object { (Get-Prop $_ 'Identity') -eq $Identity -or (Get-Prop $_ 'Identity') -eq $Sid -or (Get-Prop $_ 'Identity') -like "*$Sid*" })
  if ($mine.Count -eq 0) { return [pscustomobject]@{ Ok = $false; Reason = "no ACE for $Identity" } }
  $readish = '(^|,\s*)(Read|ReadData|ReadAndExecute|FullControl|GenericRead|GenericAll|Modify)(\s*,|$)'
  $deny = @($mine | Where-Object { (Get-Prop $_ 'Type') -eq 'Deny' -and ((Get-Prop $_ 'Rights') -match $readish -or (Get-Prop $_ 'Rights') -match 'FullControl|GenericAll') })
  if ($deny.Count -gt 0) { return [pscustomobject]@{ Ok = $false; Reason = "a Deny ACE for $Identity covers read: $(Get-Prop $deny[0] 'Rights')" } }
  $allow = @($mine | Where-Object { (Get-Prop $_ 'Type') -eq 'Allow' -and (Get-Prop $_ 'Rights') -match $readish })
  if ($allow.Count -eq 0) { return [pscustomobject]@{ Ok = $false; Reason = "ACEs exist for $Identity but none allows read: $(($mine | ForEach-Object { "$(Get-Prop $_ 'Type'):$(Get-Prop $_ 'Rights')" }) -join '; ')" } }
  return [pscustomobject]@{ Ok = $true; Reason = "allowed: $(Get-Prop $allow[0] 'Rights')" }
}

# --- the launcher's probe output ---------------------------------------------------------------------
# Counting the string "vbslike" in whatever came back treats a crashed or malformed probe as "no
# partitions exist", which is the dangerous direction. A result counts only when the process exited 0,
# the output parses, and the enumeration itself reported success.
function Read-ProbeResult {
  param([int] $ExitCode, [string] $Output)
  if ($ExitCode -ne 0) { return [pscustomobject]@{ Ok = $false; Systems = @(); Reason = "the launcher exited $ExitCode" } }
  if ([string]::IsNullOrWhiteSpace($Output)) { return [pscustomobject]@{ Ok = $false; Systems = @(); Reason = 'the launcher printed nothing' } }
  try { $j = $Output | ConvertFrom-Json -ErrorAction Stop } catch { return [pscustomobject]@{ Ok = $false; Systems = @(); Reason = "the launcher's output is not JSON: $($_.Exception.Message)" } }
  $enum = Get-Prop (Get-Prop $j 'hcs') 'HcsEnumerateComputeSystems'
  if ($null -eq $enum) { return [pscustomobject]@{ Ok = $false; Systems = @(); Reason = 'the output carries no HcsEnumerateComputeSystems result' } }
  if (-not (Get-Prop $enum 'ok')) { return [pscustomobject]@{ Ok = $false; Systems = @(); Reason = "the enumeration failed: $(Get-Prop $enum 'error')" } }
  # presence, not value: an empty list of compute systems is a valid answer and the common one
  if (-not (Test-PropPresent $enum 'result')) { return [pscustomobject]@{ Ok = $false; Systems = @(); Reason = 'the enumeration reported ok with no result array' } }
  $arr = @(Get-Prop $enum 'result')
  foreach ($s in $arr) {
    if (-not (Test-PropPresent $s 'Id') -or -not (Test-PropPresent $s 'Owner') -or
        [string]::IsNullOrWhiteSpace((Get-Prop $s 'Id')) -or [string]::IsNullOrWhiteSpace((Get-Prop $s 'Owner'))) {
      return [pscustomobject]@{ Ok = $false; Systems = @(); Reason = 'an entry has no usable Id or Owner: refusing to interpret it' }
    }
  }
  return [pscustomobject]@{ Ok = $true; Systems = $arr; Reason = "$($arr.Count) compute systems enumerated" }
}

# Which of them are OURS, by owner, and of those which belong to THIS run, by the id prefix the launcher
# gives its probe partitions. Nothing else is ever a candidate for cleanup.
function Select-OwnedSystems {
  param([object[]] $Systems, [string] $Owner = 'vbslike', [string] $IdPrefix)
  $ours = @($Systems | Where-Object { (Get-Prop $_ 'Owner') -eq $Owner })
  if ($IdPrefix) { return @($ours | Where-Object { (Get-Prop $_ 'Id') -like "$IdPrefix*" }) }
  return $ours
}
