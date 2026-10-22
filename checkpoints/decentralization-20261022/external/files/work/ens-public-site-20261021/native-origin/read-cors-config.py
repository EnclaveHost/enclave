#!/usr/bin/env python3
"""READ-ONLY on the control VM (root's authorized transport): ONLY the CORS_ORIGINS value the enclave-api-relay unit
gets (unit Environment= and its EnvironmentFile= entries; every other variable is ignored, never printed), the
EnvironmentFile paths, and the running script path + sha256. -> cors-config.json"""
import subprocess, json, pathlib, datetime
remote = r'''sudo python3 - <<'REMOTE'
import subprocess,json,re,hashlib,os,shlex
sh=lambda p: subprocess.run(['systemctl','show','enclave-api-relay','-p',p,'--value'],capture_output=True,text=True).stdout.strip()
out={'mainPid':sh('MainPID'),'workingDirectory':sh('WorkingDirectory'),'cors':[]}
for tok in shlex.split(sh('Environment')):
  if tok.startswith('CORS_ORIGINS='): out['cors'].append({'from':'unit Environment=','value':tok.split('=',1)[1]})
files=[f.split(' (')[0].lstrip('-') for f in sh('EnvironmentFiles').split('\n') if f.strip()]
out['environmentFiles']=files
for f in files:
  try:
    for line in open(f):
      m=re.match(r'\s*(?:export\s+)?CORS_ORIGINS\s*=\s*(.*)$',line)
      if m: out['cors'].append({'from':f,'value':m.group(1).strip().strip('"').strip("'")})
  except Exception as e: out['cors'].append({'from':f,'error':type(e).__name__})
try:
  env=open(f"/proc/{out['mainPid']}/environ",'rb').read().split(b'\0')
  live=[e.decode().split('=',1)[1] for e in env if e.startswith(b'CORS_ORIGINS=')]
  out['processCors']=live[0] if live else None
  out['processHasCors']=bool(live)
  cmd=open(f"/proc/{out['mainPid']}/cmdline",'rb').read().split(b'\0')
  script=[c.decode() for c in cmd if c.endswith(b'.js') or c.endswith(b'.mjs')]
  out['script']=script[:1]
  if script:
    p=script[0] if os.path.isabs(script[0]) else os.path.join(os.readlink(f"/proc/{out['mainPid']}/cwd"),script[0])
    out['scriptPath']=p; out['scriptSha256']=hashlib.sha256(open(p,'rb').read()).hexdigest()
except Exception as e: out['procError']=type(e).__name__
print(json.dumps(out))
REMOTE'''
cmd = ['ssh', '-p32423', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=work/control-vm/known_hosts', '-i', '/home/steven/.ssh/minipc', 'controladmin@127.0.0.1', remote]
r = subprocess.run(cmd, capture_output=True, text=True, timeout=45, cwd='/home/steven/Documents/Codex/2026-10-18/wo')
o = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exit': r.returncode,
     'out': json.loads(r.stdout) if r.stdout.strip().startswith('{') else r.stdout[-300:], 'err': r.stderr[-300:]}
pathlib.Path(__file__).with_name('cors-config.json').write_text(json.dumps(o, indent=1) + '\n'); print(json.dumps(o, indent=1))
