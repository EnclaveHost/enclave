import subprocess,sys,base64,hashlib,json
from pathlib import Path
HERE=Path(__file__).resolve().parent
SRC=HERE.parent/'oneoff'
REMOTE=r'C:\ProgramData\Enclave\ops\sia-cert-oneoff-20261021'
def ps(script):
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','minipc','powershell -NoProfile -EncodedCommand '+base64.b64encode(script.encode('utf-16-le')).decode()],capture_output=True,timeout=170)
 text=r.stdout.decode(errors='replace');print(text, end='')
 if r.returncode: raise SystemExit(r.returncode)
 return text
args=['--deployment','0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238','--instance','hv3f742170c660948e2bf61cc04370db94','--app-id','ea9d47738f079748b7e3fd29e18c496e2b9e88cd861473671cd9535888654ac3','--version','0.1.8','--cid','bafybeib7at4cxxzmlp3wb7v45zrhbuggwzegspcacfylztslbcnoe6qrqu','--owner','0x0b2d009c0c9af05b12100d77f3c815fea822ee61','--expect-endpoint','https://api.enclave.host/t/nucbox-k11-4','--expect-runner','0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a','--expect-operator','0x1A01194c34Fe3577C6d0a54feB78af6253e494e0','--timeout-sec','120']
mode=sys.argv[1]
if mode=='stage':
 pins={f:hashlib.sha256((SRC/f).read_bytes()).hexdigest() for f in ['sia-cert-oneoff.mjs','run-oneoff.cmd']}
 ps("$ErrorActionPreference='Stop';New-Item -ItemType Directory -Force -Path '"+REMOTE+"'|Out-Null")
 for f in pins:
  r=subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=10',str(SRC/f),'minipc:/C:/ProgramData/Enclave/ops/sia-cert-oneoff-20261021/'+f],timeout=60)
  if r.returncode:raise SystemExit(r.returncode)
 (HERE/'staged-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
 print(json.dumps(pins));raise SystemExit(0)
if mode not in ['check','run']:raise SystemExit('stage/check/run only')
pins=json.loads((HERE/'staged-pins.json').read_text())
script="$ErrorActionPreference='Stop'\n"
for f,h in pins.items():
 script+=f"if((Get-FileHash -Algorithm SHA256 -LiteralPath '{REMOTE}\\{f}').Hash.ToLower() -ne '{h}'){{throw 'helper pin mismatch'}}\n"
if mode=='run':
 check=json.loads((HERE/'check.json').read_text())
 if check.get('result')!='check passed: nothing signed or requested':raise SystemExit('need valid check')
 if check.get('operator','').lower()!='0x1a01194c34fe3577c6d0a54feb78af6253e494e0':raise SystemExit('operator mismatch')
 marker=HERE/('attempt-'+sys.argv[2]+'.json')
 with marker.open('x') as f:json.dump({'pins':pins,'mode':mode},f)
script+="& '"+REMOTE+"\\run-oneoff.cmd' --"+mode+' '+' '.join(args)+"\nexit $LASTEXITCODE\n"
# Remote nonzero result still needs a saved report.
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','minipc','powershell -NoProfile -EncodedCommand '+base64.b64encode(script.encode('utf-16-le')).decode()],capture_output=True,timeout=170)
s=r.stdout.decode(errors='replace');print(s,end='')
for line in s.splitlines():
 if line.startswith('RESULT '): (HERE/(mode+('.'+sys.argv[2] if mode=='run' else '')+'.json')).write_text(json.dumps(json.loads(line[7:]),indent=2)+'\n')
if r.stderr: print(r.stderr.decode(errors='replace')[:1000],file=sys.stderr)
sys.exit(r.returncode)
