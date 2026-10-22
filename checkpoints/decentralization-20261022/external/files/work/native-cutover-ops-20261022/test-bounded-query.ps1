param([string]$Helper)
$ErrorActionPreference='Stop'
. $Helper
function Assert($condition,$message) { if (-not $condition) { throw $message } }
$r=Invoke-BoundedQuery { [pscustomobject]@{ value=42; text='healthy' } } 5000
Assert ($r.ok -and $r.childExited -and $r.value.value -eq 42 -and $r.value.text -eq 'healthy') 'successful query lost data'
$r=Invoke-BoundedQuery { throw 'private error text must not escape' } 5000
Assert (-not $r.ok -and $r.childExited -and $null -eq $r.value -and $r.reason -eq 'query process failed') 'failed query was accepted or leaked'
$r=Invoke-BoundedQuery { Start-Sleep -Seconds 30; 'late result' } 3000
Assert ($r.timedOut -and -not $r.ok -and $r.childExited -and $r.elapsedMs -le 3000 -and $null -eq $r.value) 'slow query was not bounded'
Assert ($null -eq (Get-Process -Id $r.childId -ErrorAction SilentlyContinue)) 'own timed-out query survived'
$r=Invoke-BoundedQuery { } 5000
Assert ($r.ok -and $r.childExited -and @($r.value).Count -eq 0) 'empty successful query was confused with failure'
$refused=$false;try { $null=Invoke-BoundedQuery { 1 } 1000 }catch{$refused=$true}
Assert $refused 'budget without cleanup reserve was accepted'
[ordered]@{passed=5;timedOutChildVerifiedGone=$true}|ConvertTo-Json -Compress
