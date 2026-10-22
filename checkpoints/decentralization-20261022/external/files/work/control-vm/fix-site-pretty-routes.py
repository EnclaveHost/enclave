from pathlib import Path
import subprocess, json, sys
snippet=Path('work/control-vm/site-pretty-routes.caddy').read_text()
remote=r'''
from pathlib import Path
import subprocess, json, os, shutil, re, time
p=Path('/etc/enclave-bootstrap-tls/Caddyfile')
s=p.read_text();a=s.index('\nenclave.host {');b=s.index('\nwww.enclave.host {',a)
block=s[a:b]
assert '# BEGIN generated site pretty routes' not in block
pattern=r'(    handle \{\n        root \* (/opt/enclave-site/[^\n]+/site)\n)(        file_server\n    \})'
m=re.search(pattern,block); assert m,'main static handler missing'
site=Path(m.group(2));assert (site/'dashboard.html').is_file()
expected=(site/'dashboard.html').read_bytes()
insert=''.join('        '+line+'\n' for line in SNIPPET.splitlines())
block=block[:m.start()]+m.group(1)+insert+m.group(3)+block[m.end():]
candidate=p.with_name('Caddyfile.pretty-prepared');candidate.write_text(s[:a]+block+s[b:])
env=dict(os.environ,CREDENTIALS_DIRECTORY='/etc/enclave-bootstrap-tls/credentials')
r=subprocess.run(['/usr/local/lib/enclave-caddy/caddy','validate','--config',str(candidate),'--adapter','caddyfile'],capture_output=True,text=True,env=env)
assert r.returncode==0,r.stderr[-1800:]
backup=p.with_name('Caddyfile.before-pretty-'+str(int(time.time())))
shutil.copy2(p,backup)
try:
 shutil.copy2(candidate,p)
 subprocess.run(['systemctl','reload','enclave-bootstrap-tls'],check=True,capture_output=True)
 for suffix,want in [('/dashboard',200),('/dashboard?view=apps',200),('/develop',200),('/apps/publish',200),('/sso/authorize',200),('/no-such-page-check',404)]:
  r=subprocess.run(['curl','-sS','--max-time','15','--resolve','enclave.host:28443:127.0.0.1','-w','\n%{http_code}','https://enclave.host:28443'+suffix],capture_output=True)
  assert r.returncode==0,'local TLS request failed'
  body,code=r.stdout.rsplit(b'\n',1);assert int(code)==want,(suffix,code)
  if suffix.startswith('/dashboard'):assert body==expected,'dashboard content differs'
except:
 shutil.copy2(backup,p);subprocess.run(['systemctl','reload','enclave-bootstrap-tls'],capture_output=True);raise
print(json.dumps({'reloaded':True,'dashboardExactFile':True,'genuine404':True,'backup':str(backup)}))
'''
for host in sys.argv[1:]:
 assert host in ['us-west','eu-central','ap-southeast','ca-east']
 r=subprocess.run(['ssh','-o','BatchMode=yes',host,'python3','-'],input='SNIPPET='+repr(snippet)+'\n'+remote,text=True,capture_output=True)
 if r.returncode: raise SystemExit(host+': '+r.stderr[-2200:])
 print(host+': '+r.stdout.strip(),flush=True)
