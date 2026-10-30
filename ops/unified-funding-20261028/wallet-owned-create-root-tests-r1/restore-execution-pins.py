# Public artifact format conversion only. The executed local runner used a path->hash mapping.
from pathlib import Path
import json
p=Path(__file__).resolve().parent
f=p/'dependency-pins.json'
a=json.loads(f.read_text())
assert isinstance(a,list)
f.write_text(json.dumps({r['path']:r['sha256'] for r in a},indent=2)+'\n')
