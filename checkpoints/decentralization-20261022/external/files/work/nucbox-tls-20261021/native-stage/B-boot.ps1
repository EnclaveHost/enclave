$ErrorActionPreference='Stop'
$f='C:\ProgramData\Enclave\hotfix\nucbox-stopfix-20261021\C-test.ps1.txt'
if((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower() -ne '75ea9e73818eb29f41cc51a79fedc4402d7dfd6edc5ce5129f21319a98c67cf3'){'{"refused":"hash"}';exit 5}
$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($f),[ref]$t,[ref]$e)
if($e.Count){'{"refused":"parse"}';exit 4}
. ([scriptblock]::Create([IO.File]::ReadAllText($f)))
