#!/usr/bin/env python3
"""Read-only health of the two protected apps using the activation gate's definition."""
import datetime, importlib.util, json, pathlib
root = pathlib.Path(__file__).resolve().parents[2]
source = root / 'custody-boot-fee-activation-20261023/apphealth.py'
s = importlib.util.spec_from_file_location('apphealth', source)
m = importlib.util.module_from_spec(s)
s.loader.exec_module(m)
specs = m.load_specs(source.parent / 'apps-health.json')
rows = []
for appid, spec in specs.items():
    ok, detail = m.check(spec)
    rows.append({'id': appid, 'url': spec['url'], 'ok': ok, 'detail': detail})
out = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'readOnly': True, 'scope': 'Public app health only, strict TLS; no custody release or control adoption claim', 'apps': rows, 'ok': all(x['ok'] for x in rows)}
print(json.dumps(out, indent=2))
raise SystemExit(0 if out['ok'] else 1)
