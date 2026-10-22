from pathlib import Path
import importlib.util,json,base64,hashlib,gzip
r=Path(__file__).resolve().parent;t=r.parent/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
js=(r/'probe.mjs').read_bytes();b=base64.b64encode(gzip.compress(js,mtime=0)).decode()
ps="& '"+r'C:\Program Files\Enclave\runtime\node\node.exe'+"' --max-old-space-size=128 -e "+chr(34)+"eval(require('zlib').gunzipSync(Buffer.from('"+b+"','base64')).toString())"+chr(34)
assert len(base64.b64encode((m.HEAD.replace('SECS','60')+ps).encode('utf-16-le')))<=7900
with (r/'attempt.json').open('x') as f:json.dump({'scriptSha':hashlib.sha256(js).hexdigest(),'readOnly':True},f)
x=m.ps(ps,60)
with (r/'result.json').open('x') as f:json.dump(x,f,indent=2)
print(json.dumps(x,indent=2))
