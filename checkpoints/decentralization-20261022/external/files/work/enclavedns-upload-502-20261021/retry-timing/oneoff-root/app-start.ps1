$ErrorActionPreference='Stop'
foreach($name in 'node.log','shield.log') {
$p=Join-Path 'C:\ProgramData\Enclave\logs' $name;if(-not(Test-Path $p)){continue}
$f=[IO.File]::Open($p,'Open','Read','ReadWrite');try{[void]$f.Seek([Math]::Max(0,$f.Length-512KB),'Begin');$t=(New-Object IO.StreamReader($f)).ReadToEnd()}finally{$f.Close()}
@($t -split "`n" | Where-Object { $_ -match 'ef514ed3|hv3f742170' } | Select-Object -Last 12)|ForEach-Object{$s=$_ -replace '(?i)(authorization|signature|password|token|secret)\s*[:=]\s*\S+','$1=[redacted]';"$name $($s.Substring(0,[Math]::Min(400,$s.Length)))"}
}
