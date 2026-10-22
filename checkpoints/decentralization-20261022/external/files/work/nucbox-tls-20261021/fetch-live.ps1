$f='C:\Program Files\Enclave\control\windows\vbslike\manager\wmiserve-run.mjs'; $i=Get-Item -LiteralPath $f
'RESULT '+(@{sha256=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower(); written=$i.LastWriteTimeUtc.ToString('o'); b64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($f))} | ConvertTo-Json -Compress)
