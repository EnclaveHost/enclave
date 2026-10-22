#!/usr/bin/env python3
"""READ-ONLY, root's authorized control-VM read (root-cert-diagnostics.py), narrowed: enclave-api-relay journal with
timestamps, last 15 min, [certs] lines for 59f1273d only. -> read-relay.json"""
import subprocess, json, pathlib, datetime
remote = r'''sudo python3 - <<'REMOTE'
import subprocess,json,re
r=subprocess.run(['journalctl','-u','enclave-api-relay','--since','15 minutes ago','-n','20000','--no-pager','-o','short-iso'],capture_output=True,text=True,timeout=20)
lines=[]
for s in r.stdout.splitlines():
 if '59f1273d' in s and '[certs]' in s:
  s=re.sub(r'(?i)(token|signature|authorization)[=: ]+[^ ,;]+',r'\1=[redacted]',s)
  lines.append(s[:400])
print(json.dumps({'certLines':lines[-20:]}))
REMOTE'''
cmd = ['ssh', '-p32423', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=work/control-vm/known_hosts', '-i', '/home/steven/.ssh/minipc', 'controladmin@127.0.0.1', remote]
r = subprocess.run(cmd, capture_output=True, text=True, timeout=45, cwd='/home/steven/Documents/Codex/2026-10-18/wo')
o = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exit': r.returncode, 'out': json.loads(r.stdout) if r.stdout.strip().startswith('{') else r.stdout[-500:], 'err': r.stderr[-300:]}
pathlib.Path(__file__).with_name('read-relay.json').write_text(json.dumps(o, indent=1) + '\n'); print(json.dumps(o, indent=1))
