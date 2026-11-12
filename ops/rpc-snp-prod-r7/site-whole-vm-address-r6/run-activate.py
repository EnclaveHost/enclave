"""Activate site release r6 on the four apex edges, one at a time: fresh read-only capture, apply, verify over HTTPS.
Stops at the first failure. An edge that already has <host>.verified.json is skipped; an edge with an intent file but no
verification is NOT retried automatically (inspect <host>.result.txt first)."""
from pathlib import Path
import subprocess,sys
p=Path(__file__).resolve().parent
for host in sys.argv[1:] or ['us-west','ca-east','ap-southeast','eu-central']:
 if (p/(host+'.verified.json')).exists():print('SKIP '+host+' (already verified)',flush=True);continue
 assert not (p/(host+'.intent.json')).exists(),host+': an earlier attempt left an intent file; inspect '+host+'.result.txt before any retry'
 print('ACTIVATE '+host,flush=True)
 subprocess.run([sys.executable,str(p/'capture-current.py'),host],check=True,timeout=120)
 subprocess.run([sys.executable,str(p/'apply-edge.py'),host],check=True,timeout=190)
 subprocess.run([sys.executable,str(p/'verify-edge.py'),host],check=True,timeout=180)
print('ALL EDGES ACTIVATED AND VERIFIED')
