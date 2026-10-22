import subprocess,base64
script=r'''$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 'C:\ProgramData\Enclave\activation-stage\local-relay-20261021\10-preflight.ps1'; exit $LASTEXITCODE'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()],timeout=90)
raise SystemExit(r.returncode)
