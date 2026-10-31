$ErrorActionPreference='Stop'
$expected=@(@{pid=34528;creation='134379531029626448'},@{pid=54120;creation='134379531032747090'})
$rows=@(foreach($row in $expected){
 $process=$null
 try {$process=[Diagnostics.Process]::GetProcessById($row.pid)}catch [ArgumentException] {}
 if($null -eq $process){@{pid=$row.pid;expectedCreation=$row.creation;exactAbsent=$true;pidPresent=$false};continue}
 try {
  $held=$process.Handle;$created=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
  @{pid=$row.pid;expectedCreation=$row.creation;actualCreation=$created;exactAbsent=($created -cne $row.creation -or $process.HasExited);pidPresent=$true}
 } finally {$process.Dispose()}
})
[pscustomobject]@{success=$true;atUtc=[DateTime]::UtcNow.ToString('o');processes=$rows;readOnly=$true}|ConvertTo-Json -Depth 6 -Compress
