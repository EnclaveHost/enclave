from pathlib import Path
import os, sys, json, hashlib, base64, gzip, time
from capture_local import capture
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
phase=sys.argv[1]
assert phase in ('parse','create','copy-probe','probe','copy-media','verify')
for name,digest in json.loads((p/'PINS.json').read_text()).items():
 assert hashlib.sha256((p/name).read_bytes()).hexdigest()==digest,name
spec=json.loads((p/'SPEC.json').read_text())
pre={'create':'parse','copy-probe':'create','probe':'copy-probe','copy-media':'probe','verify':'copy-media'}
if phase in pre: assert json.loads((p/(pre[phase]+'-RESULT.json')).read_text())['success'] is True
with(p/(phase+'-INTENT.json')).open('x')as f:json.dump({'at':time.time(),'phase':phase,'noRetry':True,'vmChanged':False},f);f.flush();os.fsync(f.fileno())
options=['-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5','-oControlMaster=no','-oControlPath=none']
if phase.startswith('copy-'):
 names=['custody-probe.bin'] if phase=='copy-probe' else ['boot.vhdx','seed.iso']
 root='C:/EnclaveRpcPrivateMedia-'+spec['nonce']+'/'+spec['nonce']+'/'
 argv=['/usr/bin/scp','-3','-p','-B','-F',str(p/'ssh-config'),*options,'-X','nrequests=64','-X','buffer=32768',*['rpc-media-control:'+spec['files'][n]['path'] for n in names],'minipc:'+root]
 r=capture(argv,150 if phase=='copy-media' else 30,limit=16384)
else:
 body=(p/'stage-private-media.ps1').read_text();assert len(body.encode())<50000
 compressed=base64.b64encode(gzip.compress(body.encode(),mtime=0)).decode()
 wrapper="$b=[Convert]::FromBase64String('"+compressed+"');$m=New-Object IO.MemoryStream(,$b);$g=New-Object IO.Compression.GZipStream($m,[IO.Compression.CompressionMode]::Decompress);$r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8);$s=$r.ReadToEnd();$r.Dispose();if($s.Length-gt 50000){throw 'source bound'};"
 if phase=='parse':
  wrapper+="$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e);[pscustomobject]@{errors=@($e|ForEach-Object{$_.Message});count=@($e).Count;executed=$false}|ConvertTo-Json -Compress"
 else:
  b64=base64.b64encode(json.dumps(spec,separators=(',',':')).encode()).decode()
  wrapper+="&([scriptblock]::Create($s)) -Phase '"+phase+"' -SpecificationBase64 '"+b64+"'"
 command='powershell.exe -NoProfile -NonInteractive -EncodedCommand '+base64.b64encode(wrapper.encode('utf-16le')).decode();assert len(command)<30000
 r=capture(['/usr/bin/ssh','-T',*options,'minipc',command],45,limit=16384)
(p/(phase+'.stdout')).write_text(r.pop('stdout'))
(p/(phase+'.stderr')).write_text(r.pop('stderr'))
r.update({'at':time.time(),'phase':phase,'success':False,'noRetry':True,'vmChanged':False})
if r['rc']==0 and r['reason'] is None:
 if phase.startswith('copy-'):r['success']=True
 else:
  try:
   r['observation']=json.loads((p/(phase+'.stdout')).read_text().lstrip('\ufeff'))
   r['success']=(r['observation']['count']==0) if phase=='parse' else r['observation']['success'] is True
  except Exception:r['reason']='invalid-json-or-receipt'
(p/(phase+'-RESULT.json')).write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({'phase':phase,'success':r['success'],'rc':r['rc'],'reason':r['reason']}))
sys.exit(0 if r['success'] else 1)
