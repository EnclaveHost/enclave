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
pre={'copy-probe':'create','probe':'copy-probe','copy-media':'probe','verify':'copy-media'}
if phase in pre: assert json.loads((p/(pre[phase]+'-RESULT.json')).read_text())['success'] is True
import subprocess
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/(phase+'-LOCAL-ADMISSION.json')).write_text(json.dumps(a)+'\n')
ad=json.loads((p.parent/'rpc-successor-windows-stage-admission-r1/storage-RESULT.json').read_text());o=ad['observation']
assert ad['rc']==0 and ad['failure'] is None and time.time()-ad['at']<300
assert o['physicalAfter']['freeBytes']>=62709039104 and o['physicalAfter']['diskFreeBytes']>=16*1024**3+256*1024**2+1024**3+sum(spec['files'][n]['bytes'] for n in ['boot.vhdx','seed.iso'])
assert o['bootNative']=='1a04e76600e411f1a395e342df676a80' and o['before']==o['after'] and o['nodeExit']==0 and o['manager']['completeTransport'] and not o['manager']['errors']
assert {r['pid']:r['creationFileTime'] for r in o['nativeManagers']}=={41272:'134375630850989593',40360:'134375630828500376',41308:'134375617394407059',38076:'134375086385617521'}
for path,digest in json.loads((p/'PARSER-PROVENANCE.json').read_text()).items():assert hashlib.sha256(Path(path).read_bytes()).hexdigest()==digest
assert (p/'stage-private-media.ps1').read_bytes()==(p.parent/'rpc-private-media-stage-r2/stage-private-media.ps1').read_bytes()
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
