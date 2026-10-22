param([Parameter(Mandatory=$true)][string]$Stage)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if ($Stage -notmatch '^C:\\ProgramData\\Enclave\\staging\\txt-merge-check-[0-9a-f]{12}$') { throw 'invalid stage' }
$PF='C:\Program Files\Enclave\host-services\hs2'
$Config='C:\ProgramData\Enclave\host-services\hs2\config\host-services.json'
$Node='C:\Program Files\Enclave\runtime\node\node.exe'
function Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
$Pins=Get-Content -LiteralPath "$Stage\pins.json" -Raw | ConvertFrom-Json
foreach($p in $Pins.upload.PSObject.Properties) { if ((Sha (Join-Path $Stage $p.Name)) -ne $p.Value) { throw "staged pin mismatch: $($p.Name)" } }
if ((Sha $Node) -ne 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3') { throw 'node runtime changed' }
if ((Sha $Config) -ne 'a02e9ecd8ae1739eed8d324b4db33fe9b6d5643b5d781780949f61a1385c7cfa') { throw 'live config changed' }
$Before=@{}
foreach($p in $Pins.live.PSObject.Properties) {
  $h=Sha (Join-Path $PF $p.Name)
  if($h -ne $p.Value) { throw "live pin mismatch: $($p.Name)" }
  $Before[$p.Name]=$h
}
$Task=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2'
if([string]$Task.State -ne 'Running') { throw 'hs2 is not running' }
$Utf8=[Text.UTF8Encoding]::new($false)
# Other role packages remain exactly the running release; the candidate route-DNS package replaces only its staged copy.
foreach($role in 'directory-replica','bootstrap-replica','policy-mirror','service-tls') {
  foreach($suffix in '.mjs','.package.json') { Copy-Item -LiteralPath (Join-Path $PF "packages\$role$suffix") -Destination "$Stage\packages\$role$suffix" }
}
$Cfg=Get-Content -LiteralPath "$Stage\config.json" -Raw | ConvertFrom-Json
$Cfg.packagesDir="$Stage\packages"
[IO.File]::WriteAllText("$Stage\config.json",($Cfg|ConvertTo-Json -Depth 30),$Utf8)
# Each command is check/parse only; never run or advertise. No process, task, listener, or registry mutation.
$Results=[ordered]@{}
foreach($file in 'host-services-runner.mjs','stage-tool.mjs','packages\route-dns.mjs') {
  & $Node --check (Join-Path $Stage $file) | Out-Null
  if($LASTEXITCODE -ne 0) { throw "parse failed: $file" }
  $Results["parse:$file"]=$true
}
$out=@(& $Node --max-old-space-size=128 "$Stage\host-services-runner.mjs" check "$Stage\config.json")
if($LASTEXITCODE -ne 0) { throw 'candidate plan failed' }
$Plan=($out -join "`n")|ConvertFrom-Json
if($Plan.ok -ne $true) { throw 'candidate plan is not ok' }
$Route=@($Plan.services|Where-Object {$_.role -eq 'route-dns'})
if($Route.Count -ne 1 -or $Route[0].env -notcontains 'CHALLENGE_TXT_UPSTREAMS' -or $Route[0].env -contains 'CHALLENGE_TXT_UPSTREAM') { throw 'plural environment missing or ambiguous' }
$Results.candidatePlan=$true
# The currently live runner must refuse the new plural field. Refusal must be the intended validator, not an import error.
$oldPreference=$ErrorActionPreference; $ErrorActionPreference='Continue'
$old=@(& $Node --max-old-space-size=128 "$PF\bin\host-services-runner.mjs" check "$Stage\config.json" 2>&1|ForEach-Object {"$_"}); $oldExit=$LASTEXITCODE
$ErrorActionPreference=$oldPreference
if($oldExit -eq 0 -or ($old -join "`n") -notmatch 'unknown config field.*challengeTxtUpstreams') { throw 'old runner negative control was not the expected field refusal' }
$Results.oldRunnerRefusesPlural=$true
# Real package pin checking still rejects an altered expected digest.
$rd=@($Cfg.services|Where-Object {$_.role -eq 'route-dns'})[0];$rd.package='sha256:'+('0'*64)
[IO.File]::WriteAllText("$Stage\bad-pin.json",($Cfg|ConvertTo-Json -Depth 30),$Utf8)
$ErrorActionPreference='Continue'
$bad=@(& $Node --max-old-space-size=128 "$Stage\host-services-runner.mjs" check "$Stage\bad-pin.json" 2>&1|ForEach-Object {"$_"});$badExit=$LASTEXITCODE
$ErrorActionPreference=$oldPreference
if($badExit -eq 0 -or ($bad -join "`n") -notmatch 'is not the pinned') { throw 'bad-pin negative control was not the expected refusal' }
$Results.badPinRefused=$true
$proofOut=@(& $Node --max-old-space-size=128 "$Stage\check.bundle.mjs" "$Stage\challenge.json" "$Stage\config.json")
if($LASTEXITCODE -ne 0){throw 'installed challenge release/config proof failed'}
$Proof=($proofOut -join "`n")|ConvertFrom-Json
if($Proof.ok -ne $true){throw 'challenge proof not ok'}
$Results.installedChallengeProof=$true
$Unchanged=$true
foreach($p in $Before.Keys) {if((Sha (Join-Path $PF $p)) -ne $Before[$p]) {$Unchanged=$false}}
$Unchanged=$Unchanged -and ((Sha $Config) -eq 'a02e9ecd8ae1739eed8d324b4db33fe9b6d5643b5d781780949f61a1385c7cfa')
if(-not $Unchanged) {throw 'live program/config hash changed during validation'}
[ordered]@{at=[DateTime]::UtcNow.ToString('o');checks=$Results;challengeProof=$Proof;roles=@($Plan.services|ForEach-Object {$_.role});liveHashesUnchanged=$Unchanged;taskState=[string](Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2').State}|ConvertTo-Json -Compress -Depth 6
