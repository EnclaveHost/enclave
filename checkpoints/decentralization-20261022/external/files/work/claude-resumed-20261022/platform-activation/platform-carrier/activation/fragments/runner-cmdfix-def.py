# platform-carrier NATIVE cmd.exe FIXTURE: the exact carrier line in a throwaway batch file inside THIS run's staging dir, called by
# cmd.exe exactly as node-config.cmd calls node-config.local.cmd; prints only the variable cmd set (a public path setting), then deletes it
CMDFIX = U + (r"$d=STAGEX+'\cmdfix-'+[guid]::NewGuid().ToString('N').Substring(0,8);$null=New-Item -ItemType Directory -Path $d;$o=[ordered]@{what='cmdfix'};"
    r"try{$nl=[string][char]13+[char]10;[IO.File]::WriteAllText($d+'\local.cmd','@echo off'+$nl+'LINEX'+$nl,[Text.Encoding]::ASCII);"
    r"[IO.File]::WriteAllText($d+'\run.cmd','@echo off'+$nl+'call '+$d+'\local.cmd'+$nl+'set ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS'+$nl,[Text.Encoding]::ASCII);"
    r"$o.out=@(& cmd.exe /d /c ($d+'\run.cmd'));$o.exit=$LASTEXITCODE}finally{Remove-Item -LiteralPath $d -Recurse -Force;$o.cleaned=-not(Test-Path -LiteralPath $d)};$o|ConvertTo-Json -Compress")
def cmdfix_text(stage): return CMDFIX.replace("STAGEX", q(stage)).replace("LINEX", 'set "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS=' + CARRIERS + '"')
