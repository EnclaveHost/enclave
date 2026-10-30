"""Root foreground coordinator: preserve every attempt; retry only NOT STARTED (98)."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

r = Path(__file__).resolve().parent
w = Path('/home/steven/Documents/Codex/2026-10-18/wo/work')
queue = w / 'claude-test-queue.py'
want = '969d9273e53c79abf8604c363daa58b41a462bc4b7f3d03d813980edb771f6f4'
installed = datetime.datetime.fromisoformat('2026-10-25T20:15:08.253249+00:00').timestamp()
final = r / 'logs/root-resume-final.rc'
assert not final.exists()
while time.time() < installed + 65:
    time.sleep(min(10, installed + 65 - time.time()))
for attempt in range(2, 10):
    assert hashlib.sha256(queue.read_bytes()).hexdigest() == want
    out = r / f'logs/build-1r{attempt}.out'
    rcfile = r / f'logs/build-1r{attempt}.rc'
    assert not rcfile.exists()
    (r / 'logs/root-resume-status.json').write_text(json.dumps({'state':'attempting', 'attempt':attempt, 'time':time.time()})+'\n')
    with out.open('x') as log:
        p = subprocess.run([sys.executable, str(queue), '--mib','4096','--log',str(r/f'logs/build-1r{attempt}.guard'), '--',
                            'env','RUN=1',f'RESUME={attempt}','unshare','-rn','bash',str(r/'resume-4096.sh')], stdout=log, stderr=subprocess.STDOUT)
    rcfile.write_text(str(p.returncode)+'\n')
    if p.returncode != 98:
        break
    time.sleep(30)
final.write_text(str(p.returncode)+'\n')
(r/'logs/root-resume-status.json').write_text(json.dumps({'state':'finished','attempt':attempt,'exit':p.returncode,'time':time.time()})+'\n')
print('Resumed build result',p.returncode,'attempt',attempt,flush=True)
sys.exit(p.returncode)
