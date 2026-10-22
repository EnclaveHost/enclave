from pathlib import Path
import json
p=Path(__file__).with_name('host-current.json');d=json.loads(p.read_text());d['nodeLog']=[x.get('value','') if isinstance(x,dict) else x for x in d.get('nodeLog',[])];p.rename(p.with_name('host-current-verbose.json'));p.write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d,indent=2))
