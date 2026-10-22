import pathlib,hashlib,subprocess,base64,json,datetime
here=pathlib.Path(__file__).resolve().parent
source=here/'server.mjs.live-patched'
old='ec91cb03f694e131b0f4660bc60daed9e1f29d944bfe86dd40d53444901a7953';new='58b5d7fd76e7d3bbd3c64780a27e8475dce4dd1aa21753f1e44aaee9c5ea8beb'
assert hashlib.sha256(source.read_bytes()).hexdigest()==new
subprocess.run(['node','--input-type=module','--check'],input=source.read_bytes(),check=True)
def ps(s):
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(s.encode('utf-16le')).decode()],capture_output=True,text=True,timeout=45)
 if r.returncode:raise RuntimeError(r.stderr[:1000]+r.stdout[:1000])
 return r.stdout.strip()
folder=r'C:\ProgramData\Enclave\hotfix\enclavedns-liveness-20261021';live=r'C:\Program Files\Enclave\control\windows\vbslike\manager\server.mjs'
pre=ps(f"$ErrorActionPreference='Stop';$p='{live}';$d='{folder}';if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() -ne '{old}'){{throw 'Installed source differs; stop'}};if(Test-Path -LiteralPath $d){{throw 'Stage directory exists; reconcile before retry'}};New-Item -ItemType Directory -Path $d|Out-Null;Copy-Item -LiteralPath $p -Destination (Join-Path $d 'server.mjs.before');'STAGE_CREATED_SOURCE_UNCHANGED'")
print(pre,flush=True)
subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=15',str(source),'minipc:C:/ProgramData/Enclave/hotfix/enclavedns-liveness-20261021/server.mjs.fixed'],check=True,timeout=45)
after=ps(f"$ErrorActionPreference='Stop';$d='{folder}';$l=(Get-FileHash -LiteralPath '{live}' -Algorithm SHA256).Hash.ToLower();$b=(Get-FileHash -LiteralPath (Join-Path $d 'server.mjs.before') -Algorithm SHA256).Hash.ToLower();$n=(Get-FileHash -LiteralPath (Join-Path $d 'server.mjs.fixed') -Algorithm SHA256).Hash.ToLower();if($l -ne '{old}' -or $b -ne '{old}' -or $n -ne '{new}'){{throw 'Stage hash mismatch'}};@{{installed=$l;backup=$b;candidate=$n;directory=$d;status='STAGED_NOT_ACTIVATED'}}|ConvertTo-Json -Compress")
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'STAGED_NOT_ACTIVATED','host':'minipc','verification':json.loads(after),'restartPerformed':False,'productionSourceChanged':False}
(here/'root-stage-fix.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))
