"""Read-only service configuration inventory. Emits only validated public SNP pins and safe metadata.
No process environment, credentials, full unit text or arbitrary config values are emitted.
"""
import datetime, json, pathlib, re, shlex, subprocess, hashlib
ALLOWED={'APP_CHALLENGE_MEASUREMENTS','APP_CHALLENGE_MIN_TCB','ATTESTED_MEASUREMENTS','ATTESTED_MIN_TCB','APP_CHALLENGE_AUTH','DNS_CHALLENGE_AUTH'}
def show(unit, prop):
 p=subprocess.run(['systemctl','show',unit,'-p',prop,'--value'],capture_output=True,text=True,timeout=15)
 if p.returncode: raise RuntimeError('systemctl property unavailable: '+prop)
 return p.stdout.strip()
def clean(k,v):
 if k.endswith('MEASUREMENTS'):
  vals=[x.strip() for x in v.split(',') if x.strip()]
  return vals if vals and all(re.fullmatch('[0-9a-fA-F]{96}',x) for x in vals) else {'valid':False,'count':len(vals)}
 if k.endswith('MIN_TCB'):return v if re.fullmatch('[0-9]{1,20}',v) else {'valid':False}
 return v if v in ('attested','attested-lease','') else {'recognized':False}
rows=[]
for unit in ['enclave-dns.service','enclave-api-relay.service']:
 row={'unit':unit,'active':show(unit,'ActiveState'),'started':show(unit,'ExecMainStartTimestamp'),'fragment':show(unit,'FragmentPath'),'dropins':show(unit,'DropInPaths').split()}
 env={}; paths=[]; sources=[]
 for value in shlex.split(show(unit,'Environment')):
  if '=' in value:
   k,v=value.split('=',1)
   if k in ALLOWED:env[k]=clean(k,v)
 files=show(unit,'EnvironmentFiles')
 # systemctl's public path list: path (ignore_errors=yes/no). Reject ambiguous formats.
 for m in re.finditer(r'(/[^\s]+) \(ignore_errors=(?:yes|no)\)',files):paths.append(m.group(1))
 remainder=re.sub(r'(/[^\s]+) \(ignore_errors=(?:yes|no)\)','',files).strip()
 if remainder:raise RuntimeError('unsupported EnvironmentFiles format')
 related=set()
 for name in paths:
  p=pathlib.Path(name)
  if not p.is_file():sources.append({'path':name,'present':False});continue
  raw=p.read_bytes(); keys=[]
  for line in raw.decode().splitlines():
   m=re.match(r'^\s*([A-Z][A-Z0-9_]*)=(.*)$',line)
   if not m:continue
   k,v=m.groups()
   if 'MEASUREMENT' in k or 'TCB' in k:related.add(k)
   if k not in ALLOWED:continue
   # Allowed public pin values have no whitespace/escape syntax beyond optional enclosing quotes.
   v=v.strip()
   if len(v)>=2 and v[0]==v[-1] and v[0] in '\"\'':v=v[1:-1]
   env[k]=clean(k,v);keys.append(k)
  sources.append({'path':name,'present':True,'sha256':hashlib.sha256(raw).hexdigest(),'publicKeys':keys})
 row.update(publicSettings=env,relatedKeyNames=sorted(related),environmentFiles=sources)
 rows.append(row)
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'configurationOnly':True,'services':rows},indent=2))
