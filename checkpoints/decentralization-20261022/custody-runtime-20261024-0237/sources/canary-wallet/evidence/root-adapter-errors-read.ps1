$ErrorActionPreference='Stop'
foreach($name in @('node.log','network.log')){
 $p=Join-Path $env:ProgramData "Enclave\logs\$name"
 $f=[IO.File]::Open($p,'Open','Read','ReadWrite');try{[void]$f.Seek([Math]::Max(0,$f.Length-2MB),'Begin');$text=(New-Object IO.StreamReader($f)).ReadToEnd()}finally{$f.Close()}
 $lines=@($text -split "`n"|Where-Object{$_ -match '7ae476a3|ef514ed3' -and $_ -match 'timeout|504|refused|egress|reset|closed'}|Select-Object -Last 12)
 foreach($l in $lines){if($l -match '(?i)secret|token|password|private|signature|authorization|cookie|credential'){"$name [sensitive diagnostic withheld]";continue};$s=$l -replace 'https?://[^\s"<>]+','[endpoint]' -replace '(?i)(0x)?[a-f0-9]{40,}','[hex]' -replace '[A-Za-z0-9_+/=-]{48,}','[opaque]';if($s.Length -gt 400){$s=$s.Substring(0,400)};"$name $s"}
}
