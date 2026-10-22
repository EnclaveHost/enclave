# READ-ONLY probe 3: which manager source is LIVE on minipc, and its server.mjs / wmi-launcher.mjs / backend.mjs / main.mjs
# (public source code; no config, env or keys). Script paths come from process command lines, keeping only .mjs tokens.
import subprocess, base64, pathlib, json
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'; $o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')}
$o.procs=@(Get-CimInstance Win32_Process | Where-Object { [string]$_.CommandLine -match '\.mjs' } | ForEach-Object { [ordered]@{pid=$_.ProcessId; exe=$_.Name; started=([string]$_.CreationDate); mjs=@([regex]::Matches([string]$_.CommandLine,'[A-Za-z]:\\[^"]+?\.mjs') | ForEach-Object { $_.Value })} })
$dirs=@($o.procs | ForEach-Object { $_.mjs } | Where-Object { $_ -match 'vbslike\\manager\\main\.mjs$' } | ForEach-Object { Split-Path $_ -Parent } | Select-Object -Unique)
$o.managerDirs=$dirs; $o.files=[ordered]@{}
foreach($d in $dirs){ foreach($n in 'server.mjs','wmi-launcher.mjs','backend.mjs','main.mjs'){ $f=Join-Path $d $n; if(Test-Path -LiteralPath $f){ $b=[IO.File]::ReadAllBytes($f); $o.files[$f]=[ordered]@{sha256=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower(); b64=[Convert]::ToBase64String($b)} } } }
'RESULT '+($o | ConvertTo-Json -Depth 6 -Compress)
'''
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=170)
here = pathlib.Path(__file__).parent
(here / 'probe3.out').write_bytes(r.stdout + r.stderr)
txt = r.stdout.decode('utf-8', 'replace')
i = txt.find('RESULT ')
if i >= 0:
    j = json.loads(txt[i + 7:].strip().splitlines()[0])
    live = here / 'live-manager'; live.mkdir(exist_ok=True)
    for path, f in (j.get('files') or {}).items():
        (live / path.replace(':', '').replace('\\', '__')).write_bytes(base64.b64decode(f['b64'])); f.pop('b64')
    (here / 'probe3.json').write_text(json.dumps(j, indent=1))
print('SSH_EXIT', r.returncode, 'bytes', len(r.stdout))
raise SystemExit(r.returncode)
