$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(280);while(-not $t.WaitForExit(2000)){$t.Refresh();if($t.PrivateMemorySize64 -gt 512MB -or (Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
$S='C:\ProgramData\Enclave\hotfix\nucbox-stopfix-20261021';$N='C:\Program Files\Enclave\runtime\node\node.exe'
$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o')}
function FileSha($f){(Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower()}
$want=@{'fixed\wmiserve-run.mjs'='8107f272741c40a3d6ea51c0054d5fdc0904cd277346265cd01ca9de1c74ed17';'fixed\wmiserve-run.test.mjs'='83b201f0d541586a161759f20ecb7ffffc776fd8d542af9c0598fe8d8974055c';'fixed\testdata\fake-wmiserve.mjs'='5b7b9f9c7176ec002ddfb8d63897eb274d3fce8bf1e5ac1c2cac66a47874c210';'mut\wmiserve-run.mjs'='c0154d17372a09fa08d9c4c8675496668fa927774da5245bb2d6892410feddde';'mut\wmiserve-run.test.mjs'='83b201f0d541586a161759f20ecb7ffffc776fd8d542af9c0598fe8d8974055c';'mut\testdata\fake-wmiserve.mjs'='5b7b9f9c7176ec002ddfb8d63897eb274d3fce8bf1e5ac1c2cac66a47874c210'}
$bad=@($want.Keys|Where-Object{(FileSha "$S\$_") -ne $want[$_]});$o.hashMismatches=$bad;if($bad.Count){$o|ConvertTo-Json -Compress;exit 4}
$env:TEMP="$S\tmp";$env:TMP="$S\tmp"
function RunNode([string]$name,[string]$dir,[string[]]$a){$out="$S\results\$name.out";$err="$S\results\$name.err"
$p=Start-Process -FilePath $N -ArgumentList $a -WorkingDirectory $dir -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -PassThru
$null=$p.Handle;$done=$p.WaitForExit(120000);if(-not $done){& taskkill.exe /PID $p.Id /T /F|Out-Null;$null=$p.WaitForExit(10000)}
$txt=[IO.File]::ReadAllText($out)+[IO.File]::ReadAllText($err)
[ordered]@{rc=$(if($done){[int]$p.ExitCode}else{'killed by the 120 s watchdog'});tests=[string]([regex]::Match($txt,'# tests (\d+)').Groups[1].Value);pass=[string]([regex]::Match($txt,'# pass (\d+)').Groups[1].Value);fail=[string]([regex]::Match($txt,'# fail (\d+)').Groups[1].Value);notOk=@([regex]::Matches($txt,'(?m)^not ok .*$')|ForEach-Object{$_.Value.Trim()});writeAfterEnd=[bool]($txt -match 'ERR_STREAM_WRITE_AFTER_END')}}
$o.checkFixedModule=RunNode 'check-module' "$S\fixed" @('--check','wmiserve-run.mjs')
$o.checkFixedTest=RunNode 'check-test' "$S\fixed" @('--check','wmiserve-run.test.mjs')
$o.checkFake=RunNode 'check-fake' "$S\fixed" @('--check','testdata\fake-wmiserve.mjs')
$o.fixedSuite=RunNode 'fixed-suite' "$S\fixed" @('--test','--test-concurrency=1','wmiserve-run.test.mjs')
$o.mutation=RunNode 'mutation' "$S\mut" @('--test','--test-concurrency=1','--test-name-pattern=two stops of one run|closed its stdin','wmiserve-run.test.mjs')
$o.leftoverNode=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20|Where-Object{[string]$_.CommandLine -like "*$S*" -or [string]$_.CommandLine -like '*fake-wmiserve*'}).Count
$o.tmpEntries=@(Get-ChildItem -LiteralPath "$S\tmp" -Force).Count
$o.liveStill=[ordered]@{wmiserve=FileSha 'C:\Program Files\Enclave\control\windows\vbslike\manager\wmiserve-run.mjs';server=FileSha 'C:\Program Files\Enclave\control\windows\vbslike\manager\server.mjs'}
$o|ConvertTo-Json -Depth 4 -Compress
