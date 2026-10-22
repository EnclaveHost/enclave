$ErrorActionPreference='Stop'
Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'shield-egress.exe'}|ForEach-Object{[pscustomobject]@{pid=$_.ProcessId;path=$_.ExecutablePath;deployment=([regex]::Match($_.CommandLine,'0x[0-9a-f]{64}')).Value;sha=(Get-FileHash $_.ExecutablePath -Algorithm SHA256).Hash}}|ConvertTo-Json -Compress
