import urllib.request,json,datetime
import guestrows
from pathlib import Path
p=Path('work/linux-post-adoption-release/activation');plan=json.loads((p/'plan.json').read_text())
u='https://api.enclave.host/t/metal0/availability'
with urllib.request.urlopen(u,timeout=20) as r:d=json.load(r)
held=[x for x in (d.get('instanceSweep') or {}).get('held',[]) if str(x.get('id','')).lower() in plan['apps']]
baseline=guestrows.baseline(held, plan['apps'])
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'availability':u,'held':held,'baseline':baseline,'tenantVouch':d.get('tenantVouch'),'guestPool':d.get('guestPool')}
(p/'public-baseline.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
