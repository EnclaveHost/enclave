#!/usr/bin/env python3
"""READ-ONLY: the CORS lines of the LIVE /opt/nan-relay/api-relay.js (source text, no config/env), with line numbers,
plus whether the live source sets cookies. -> live-cors-src.json"""
import subprocess, json, pathlib, datetime
remote = r'''python3 - <<'REMOTE'
import json,re
s=open('/opt/nan-relay/api-relay.js').read().split('\n')
pick=[(i+1,l[:220]) for i,l in enumerate(s) if re.search(r'CORS_ORIGINS|corsAllowed|Access-Control-Allow-(Origin|Credentials)|const cors = ',l)]
print(json.dumps({'lines':pick,'setsCookie':any(re.search(r'(?i)set-cookie',l) for l in s),'nLines':len(s)}))
REMOTE'''
cmd = ['ssh', '-p32423', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=work/control-vm/known_hosts', '-i', '/home/steven/.ssh/minipc', 'controladmin@127.0.0.1', remote]
r = subprocess.run(cmd, capture_output=True, text=True, timeout=45, cwd='/home/steven/Documents/Codex/2026-10-18/wo')
o = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exit': r.returncode, 'out': json.loads(r.stdout) if r.stdout.strip().startswith('{') else r.stdout[-300:], 'err': r.stderr[-300:]}
pathlib.Path(__file__).with_name('live-cors-src.json').write_text(json.dumps(o, indent=1) + '\n'); print(json.dumps(o, indent=1))
