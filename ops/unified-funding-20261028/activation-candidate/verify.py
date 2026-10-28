from pathlib import Path
import json,hashlib
p=Path(__file__).resolve().parent
m=json.loads((p/'generated/PREPARE-MANIFEST.json').read_text())
for f,h in m['outputs'].items():
 assert hashlib.sha256((p/f).read_bytes()).hexdigest()==h,f
print('All five generated source hashes match reviewed stage')
