$ErrorActionPreference='Stop'
$p='C:\ProgramData\Enclave\logs\shield.log';$f=[IO.File]::Open($p,'Open','Read','ReadWrite');try{[void]$f.Seek([Math]::Max(0,$f.Length-1MB),'Begin');$t=(New-Object IO.StreamReader($f)).ReadToEnd()}finally{$f.Close()}
@($t -split "`n"|Where-Object { $_ -match '53b2c83c' -and $_ -match 'refused|admit|connect|error|closed' }|Select-Object -Last 8)|ForEach-Object{$_.Substring(0,[Math]::Min(500,$_.Length))}
