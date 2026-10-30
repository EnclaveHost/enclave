from pathlib import Path
import json,hashlib,subprocess,os
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
sha=lambda f:hashlib.file_digest(f.open('rb'),'sha256').hexdigest()
pins=json.loads((p/'ROOT-READ-PINS.json').read_text())
assert all(sha(Path(n))==h for n,h in pins.items())
r=subprocess.run(['/usr/bin/python3','-B',str(p/'fresh-read.py')],timeout=55)
assert all(sha(Path(n))==h for n,h in pins.items())
raise SystemExit(r.returncode)
