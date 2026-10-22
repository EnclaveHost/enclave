$ErrorActionPreference='Stop'
foreach ($d in @((Join-Path $env:ProgramData 'Enclave\logs\partitions'), (Join-Path $env:ProgramData 'Enclave\logs'), (Join-Path $env:ProgramData 'Enclave\shield'))) {
  Write-Output "DIR $d exists=$(Test-Path -LiteralPath $d)"
  if (Test-Path -LiteralPath $d) { Get-ChildItem -LiteralPath $d -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 15 | ForEach-Object { Write-Output ("  {0}  {1}  {2:o}" -f $_.Name, $_.Length, $_.LastWriteTimeUtc) } } }
