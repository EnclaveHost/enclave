$ErrorActionPreference='Stop'
$script:n=0
function Fail { throw 'inner' }
function Rev { $script:n++; Write-Output "rev $script:n"; if ($script:n -eq 1) { Fail } ; 'rev-ok' }
trap {
  Write-Output "trap: $($_.Exception.Message) n=$script:n"
  if ($script:mode -eq 'throwintrap') { throw 'from-trap' }
  try { Rev | Out-Null; Write-Output 'trap revert ok'; exit 0 } catch { Write-Output "trap catch $($_.Exception.Message)"; exit 1 }
}
$script:mode=$args[0]
$r = Rev
Write-Output 'after main revert'
