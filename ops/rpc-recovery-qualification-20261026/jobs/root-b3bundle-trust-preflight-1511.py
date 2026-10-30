import hashlib,json,subprocess,tempfile
from pathlib import Path
key=Path('logs/guest-trust-1492/ubuntu-archive-keyring.gpg').resolve()
assert hashlib.sha256(key.read_bytes()).hexdigest()=='80a36b0a6de2f69f49d2df75ef473ccde121e9e190b9ea01d20a4f63778d5c31'
with tempfile.TemporaryDirectory(prefix='rpc-public-key-inspect-') as home:
 p=subprocess.run(['gpg','--no-options','--homedir',home,'--batch','--with-colons','--show-keys',str(key)],capture_output=True,text=True,timeout=20)
 assert p.returncode==0,p.stderr
 keys=[];want=False
 for line in p.stdout.splitlines():
  fields=line.split(':')
  if fields[0]=='pub':want=True
  elif fields[0]=='sub':want=False
  elif fields[0]=='fpr' and want:keys.append(fields[9]);want=False
 assert keys and all(len(x)==40 for x in keys)
url='https://archive.ubuntu.com/ubuntu/dists/noble/InRelease'
p=subprocess.run(['curl','--proto','=https','--max-redirs','0','--max-time','30','--silent','--show-error','--head','--output','/dev/null','--write-out','%{http_code}',url],capture_output=True,text=True,timeout=40)
r={'keyringSha256':hashlib.sha256(key.read_bytes()).hexdigest(),'primaryFingerprints':keys,'probeUrl':url,'curlReturncode':p.returncode,'httpStatus':p.stdout.strip(),'stderr':p.stderr.strip(),'provenance':'read-only extracted guest keyring; HTTPS reachability only, no package qualification'}
Path('logs/b3bundle-trust-preflight-1511.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
