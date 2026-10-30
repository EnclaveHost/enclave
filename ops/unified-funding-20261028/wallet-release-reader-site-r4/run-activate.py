from pathlib import Path
import subprocess,os
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{1})
for host in ['us-west','ca-east','ap-southeast','eu-central']:
 print('ACTIVATE '+host,flush=True)
 subprocess.run(['python3',str(p/'apply-edge.py'),host],check=True,timeout=190)
 subprocess.run(['python3',str(p/'verify-edge.py'),host],check=True,timeout=180)
