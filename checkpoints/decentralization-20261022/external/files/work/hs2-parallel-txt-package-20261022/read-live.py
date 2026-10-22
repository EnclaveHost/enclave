from pathlib import Path
import importlib.util,hashlib,json,datetime
r=Path(__file__).resolve().parent;w=r.parent
p=w/'challenge-host-tls-20261021/g4/root-hs2-g4.py'
spec=importlib.util.spec_from_file_location('prior_driver',p);d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
t=w/'nucbox-tls-20261021/root-activate-reviewed.py';assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
spec=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
manifest=json.loads((r/'bundle/upgrade-manifest.json').read_text())
text=d.facts_text(manifest)
# Read-only metadata/hash projection. No health/start/restart or journal cleanup call.
x=m.ps(text,90)
if 'error' in x:raise RuntimeError(x)
expected={a['path']:a['old'] for a in manifest['replace']};expected.update({a['path']:a['sha'] for a in manifest['unchanged']})
checks={'allProgramPins':x.get('files')==expected,'configPin':x.get('config')==manifest['config']['old'],'receiptPin':x.get('receipt')==manifest['receipt']['old'],'noActiveLock':x.get('lock') is None,'taskRunning':x.get('taskState')=='Running','noUpgradeHelper':x.get('helpers')==0}
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'facts':x,'checks':checks,'ok':all(checks.values()),'productionChanges':False}
(r/'live-read.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'at':out['at'],'checks':checks}));raise SystemExit(0 if out['ok'] else 1)
